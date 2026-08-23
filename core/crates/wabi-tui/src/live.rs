//! Socket.IO live feed — bridges server events into the app's `BgMsg` queue.
//!
//! Wire contract (verified against wabi-server `socketio/wiring.rs`):
//! - Handshake auth: `{ token: <jwt> }`; invalid tokens get `auth-failed`.
//! - After connect: emit `"join"` (username), then `"join-channel"` per room.
//!   Note: `join-channel` takes a bare string payload, not an object.
//! - Inbound `"message"`: `{"channelId": str, "message": {...view}}`.
//! - Inbound `"typing"`: `{"channelId": str, "usernames": [..]}`.
//!
//! rust-socketio 0.6 callbacks run on the client's own threads and receive a
//! `RawClient` handle for emits; they must not touch app state. Everything
//! funnels through `tx.blocking_send(BgMsg::…)` so the main loop stays the
//! single mutator (same pattern as the REST spawn helpers).

use anyhow::{anyhow, Result};
use rust_socketio::client::Client;
use rust_socketio::{ClientBuilder, Event, Payload};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use tokio::sync::mpsc;

use crate::app::{BgMsg, Message};

/// Shared connection health, readable cheaply from the render loop.
#[derive(Debug, Default)]
pub struct LiveHealth {
    connected: AtomicBool,
    /// Last inbound live event, ms since epoch (staleness guard for polling).
    pub last_event_ms: AtomicU64,
}

impl LiveHealth {
    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }
    fn set_connected(&self, v: bool) {
        self.connected.store(v, Ordering::Relaxed);
    }
    pub fn mark_event(&self, now_ms: u64) {
        self.last_event_ms.store(now_ms, Ordering::Relaxed);
    }
}

/// Handle to a live socket. Cloneable; connect before first use.
#[derive(Clone)]
pub struct LiveClient {
    client: Arc<Mutex<Option<Client>>>,
    pub health: Arc<LiveHealth>,
}

impl std::fmt::Debug for LiveClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveClient")
            .field("connected", &self.health.is_connected())
            .finish()
    }
}

impl LiveClient {
    pub fn new() -> Self {
        Self {
            client: Arc::new(Mutex::new(None)),
            health: Arc::new(LiveHealth::default()),
        }
    }

    /// Connect to `<server>/socket.io/` with JWT auth. On success the socket
    /// joins the presence room (`join`) and one channel room.
    pub fn connect(
        &self,
        base_url: &str,
        token: &str,
        username: &str,
        channel_id: &str,
        tx: mpsc::Sender<BgMsg>,
    ) -> Result<()> {
        let url = format!("{}/socket.io/", base_url.trim_end_matches('/'));
        let username = username.to_string();
        let join_channel = channel_id.to_string();

        let builder = ClientBuilder::new(url)
            .namespace("/")
            .auth(json!({ "token": token }))
            .on(Event::Connect, {
                let tx = tx.clone();
                let health = self.health.clone();
                move |_payload: Payload, client: rust_socketio::RawClient| {
                    health.set_connected(true);
                    health.mark_event(now_ms());
                    // Presence join, then the requested channel room.
                    // join-channel takes a bare string payload.
                    if let Err(e) = client.emit("join", username.as_str()) {
                        tracing::warn!("live join failed: {e}");
                    }
                    if !join_channel.is_empty() {
                        if let Err(e) = client.emit("join-channel", join_channel.as_str()) {
                            tracing::warn!("live join-channel failed: {e}");
                        }
                    }
                    if tx.blocking_send(BgMsg::LiveConnected).is_err() {
                        tracing::warn!("bg channel closed; live event dropped");
                    }
                }
            })
            .on(Event::Close, {
                let tx = tx.clone();
                let health = self.health.clone();
                move |payload: Payload, _client: rust_socketio::RawClient| {
                    health.set_connected(false);
                    let reason = payload_value(&payload)
                        .map(|v| v.to_string())
                        .unwrap_or_default();
                    if tx
                        .blocking_send(BgMsg::LiveDisconnected(format!("closed: {reason}")))
                        .is_err()
                    {
                        tracing::warn!("bg channel closed; live event dropped");
                    }
                }
            })
            .on("message", {
                let tx = tx.clone();
                let health = self.health.clone();
                move |payload: Payload, _client: rust_socketio::RawClient| {
                    if let Some(v) = payload_value(&payload) {
                        if let Some((ch, msg)) = parse_inbound_message(&v) {
                            health.mark_event(now_ms());
                            if tx
                                .blocking_send(BgMsg::LiveMessage {
                                    channel_id: ch,
                                    message: msg,
                                })
                                .is_err()
                            {
                                tracing::warn!("bg channel closed; live event dropped");
                            }
                        }
                    }
                }
            })
            .on("typing", {
                let tx = tx.clone();
                let health = self.health.clone();
                move |payload: Payload, _client: rust_socketio::RawClient| {
                    if let Some(v) = payload_value(&payload) {
                        let ch = v.get("channelId").and_then(|x| x.as_str()).unwrap_or("");
                        if let Some(u) = v.get("usernames").and_then(|x| x.as_array()) {
                            if let Some(name) = u.first().and_then(|x| x.as_str()) {
                                if !name.is_empty() && !ch.is_empty() {
                                    health.mark_event(now_ms());
                                    if tx
                                        .blocking_send(BgMsg::LiveTyping {
                                            channel_id: ch.to_string(),
                                            username: name.to_string(),
                                        })
                                        .is_err()
                                    {
                                        tracing::warn!("bg channel closed; live event dropped");
                                    }
                                }
                            }
                        }
                    }
                }
            });

        let client = builder.connect().map_err(|e| anyhow!("socket.io: {e}"))?;
        *self.client.lock().expect("live lock") = Some(client);
        Ok(())
    }

    pub fn is_connected(&self) -> bool {
        self.health.is_connected()
    }

    /// Join a channel room after switching channels (no-op when offline).
    pub fn join_channel(&self, channel_id: &str) {
        if let Some(client) = self.client.lock().expect("live lock").as_ref() {
            if let Err(e) = client.emit("join-channel", channel_id) {
                tracing::warn!("live join-channel({channel_id}) failed: {e}");
            }
        }
    }

    /// Announce typing in a channel (throttled by the caller).
    pub fn send_typing(&self, channel_id: &str) {
        if let Some(client) = self.client.lock().expect("live lock").as_ref() {
            let payload = json!({ "channelId": channel_id });
            if let Err(e) = client.emit("typing", payload) {
                tracing::warn!("live typing failed: {e}");
            }
        }
    }
}

/// Normalize any payload shape into a single JSON value.
fn payload_value(p: &Payload) -> Option<Value> {
    match p {
        Payload::Text(values) => values.first().cloned(),
        Payload::Binary(_) => None,
        Payload::String(s) => Some(Value::String(s.clone())),
    }
}

/// Extract `(channel_id, Message)` from an inbound `message` event body.
fn parse_inbound_message(v: &Value) -> Option<(String, Message)> {
    let channel_id = v.get("channelId")?.as_str()?.to_string();
    let m = v.get("message")?;
    let id = m
        .get("id")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let text = m
        .get("text")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let sender_name = m
        .get("user")
        .and_then(|x| x.as_str())
        .unwrap_or("?")
        .to_string();
    let sender_id = m
        .get("userId")
        .and_then(|x| x.as_str())
        .and_then(parse_user_num)
        .unwrap_or(0);
    let timestamp = m
        .get("timestamp")
        .and_then(|x| x.as_i64())
        .or_else(|| m.get("bornAt").and_then(|x| x.as_i64()))
        .unwrap_or(0);
    let message_type = m
        .get("type")
        .and_then(|x| x.as_str())
        .unwrap_or("text")
        .to_string();
    if id.is_empty() || text.is_empty() {
        return None;
    }
    Some((
        channel_id.clone(),
        Message {
            id,
            channel_id,
            sender_id,
            sender_name,
            text,
            timestamp,
            message_type,
        },
    ))
}

/// Server sends `userId` as `"user-123"` (stable id) or occasionally a raw
/// number string. Pull the numeric part; guests resolve to 0.
fn parse_user_num(s: &str) -> Option<i64> {
    s.strip_prefix("user-")
        .unwrap_or(s)
        .trim()
        .parse::<i64>()
        .ok()
        .or(Some(0))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
