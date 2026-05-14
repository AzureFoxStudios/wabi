//! Webhook service for Wabi
//!
//! Triggers webhooks on events (message.created, user.joined, etc.)
//! Full delivery with retries to be implemented

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tracing::{debug, info};

/// Webhook event types
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum WebhookEvent {
    MessageCreated {
        message_id: i64,
        channel_id: i64,
        user_id: i64,
    },
    ChannelCreated {
        channel_id: i64,
        name: String,
    },
    UserJoined {
        user_id: i64,
        username: String,
    },
    UserLeft {
        user_id: i64,
        username: String,
    },
}

/// Webhook configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Webhook {
    pub id: i64,
    pub url: String,
    pub events: Vec<String>,
    pub secret: Option<String>,
}

/// Webhook delivery service
pub struct WebhookService {
    webhooks: Vec<Webhook>,
}

impl WebhookService {
    /// Create new webhook service with given webhooks
    pub fn new(webhooks: Vec<Webhook>) -> Self {
        Self { webhooks }
    }

    /// Trigger a webhook event
    pub async fn trigger(&self, event: WebhookEvent) -> Result<()> {
        if self.webhooks.is_empty() {
            return Ok(());
        }

        let event_name = match &event {
            WebhookEvent::MessageCreated { .. } => "message.created",
            WebhookEvent::ChannelCreated { .. } => "channel.created",
            WebhookEvent::UserJoined { .. } => "user.joined",
            WebhookEvent::UserLeft { .. } => "user.left",
        };

        let payload = match &event {
            WebhookEvent::MessageCreated {
                message_id,
                channel_id,
                user_id,
            } => {
                json!({ "type": "message.created", "message_id": message_id, "channel_id": channel_id, "user_id": user_id })
            }
            WebhookEvent::ChannelCreated { channel_id, name } => {
                json!({ "type": "channel.created", "channel_id": channel_id, "name": name })
            }
            WebhookEvent::UserJoined { user_id, username } => {
                json!({ "type": "user.joined", "user_id": user_id, "username": username })
            }
            WebhookEvent::UserLeft { user_id, username } => {
                json!({ "type": "user.left", "user_id": user_id, "username": username })
            }
        };

        info!(
            "Triggering webhook event: {} ({} webhooks)",
            event_name,
            self.webhooks.len()
        );

        for webhook in &self.webhooks {
            if webhook.events.iter().any(|e| e == event_name) {
                debug!("Would deliver to webhook: {} - {:?}", webhook.url, payload);
            }
        }

        Ok(())
    }
}
