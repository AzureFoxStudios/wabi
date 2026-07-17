//! Wabi API client

use anyhow::{Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::app::{Channel, Message};

#[derive(Debug, Clone)]
pub struct ApiClient {
    base_url: String,
    client: Client,
    token: Option<String>,
}

#[derive(Serialize)]
struct LoginRequest {
    username: String,
    password: String,
}

#[derive(Deserialize)]
struct LoginResponse {
    token: Option<String>,
    user: Option<UserResponse>,
}

#[derive(Deserialize)]
struct UserResponse {
    id: i64,
    username: String,
}

#[derive(Debug)]
pub struct LoginResult {
    pub token: String,
    pub user_id: i64,
    pub username: String,
}

#[derive(Deserialize)]
struct ChannelsResponse {
    channels: Vec<ChannelResponse>,
}

#[derive(Deserialize)]
struct ChannelResponse {
    id: String,
    name: String,
    #[serde(default)]
    channel_type: String,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Deserialize)]
struct MessagesResponse {
    messages: Vec<MessageResponse>,
}

#[derive(Deserialize)]
struct MessageResponse {
    id: String,
    channel_id: String,
    user_id: String,
    #[serde(default)]
    username: String,
    content: String,
    #[serde(default)]
    message_type: String,
    created_at: i64,
}

impl ApiClient {
    pub fn new(base_url: &str) -> Self {
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            client,
            token: None,
        }
    }

    pub fn set_token(&mut self, token: String) {
        self.token = Some(token);
    }

    pub async fn health(&self) -> Result<()> {
        let url = format!("{}/health", self.base_url);
        let resp = self.client.get(&url).send().await?;
        if resp.status().is_success() {
            Ok(())
        } else {
            anyhow::bail!("Server returned {}", resp.status());
        }
    }

    pub async fn login(&self, username: &str, password: &str) -> Result<LoginResult> {
        let url = format!("{}/api/auth/login", self.base_url);
        let resp = self
            .client
            .post(&url)
            .json(&LoginRequest {
                username: username.to_string(),
                password: password.to_string(),
            })
            .send()
            .await?;

        if !resp.status().is_success() {
            let error = resp.text().await.unwrap_or_default();
            anyhow::bail!("Login failed: {}", error);
        }

        let data: LoginResponse = resp
            .json()
            .await
            .context("Failed to parse login response")?;
        let token = data
            .token
            .ok_or_else(|| anyhow::anyhow!("No token in response"))?;
        let (user_id, uname) = data
            .user
            .map(|u| (u.id, u.username))
            .unwrap_or((0, username.to_string()));
        Ok(LoginResult {
            token,
            user_id,
            username: uname,
        })
    }

    pub async fn get_channels(&self) -> Result<Vec<Channel>> {
        let url = format!("{}/api/channels", self.base_url);
        let mut req = self.client.get(&url);
        if let Some(ref t) = self.token {
            req = req.bearer_auth(t);
        }
        let resp = req.send().await?;
        if !resp.status().is_success() {
            anyhow::bail!("Channels request failed: {}", resp.status());
        }
        let data: ChannelsResponse = resp.json().await.context("Failed to parse channels")?;
        Ok(data
            .channels
            .into_iter()
            .map(|c| Channel {
                id: c.id,
                name: c.name,
                channel_type: c.channel_type,
                description: c.description,
            })
            .collect())
    }

    pub async fn get_messages(&self, channel_id: &str, limit: u32) -> Result<Vec<Message>> {
        let url = format!(
            "{}/api/messages/{}?limit={}",
            self.base_url, channel_id, limit
        );
        let mut req = self.client.get(&url);
        if let Some(ref t) = self.token {
            req = req.bearer_auth(t);
        }
        let resp = req.send().await?;
        if !resp.status().is_success() {
            anyhow::bail!("Messages request failed: {}", resp.status());
        }
        let data: MessagesResponse = resp.json().await.context("Failed to parse messages")?;

        Ok(data
            .messages
            .into_iter()
            .map(|m| {
                let display_name = if !m.username.is_empty() {
                    m.username.clone()
                } else {
                    m.user_id.clone()
                };
                Message {
                    id: m.id,
                    channel_id: m.channel_id,
                    sender_id: m.user_id.parse::<i64>().unwrap_or(0),
                    sender_name: display_name,
                    text: m.content,
                    timestamp: m.created_at,
                    message_type: m.message_type,
                }
            })
            .collect())
    }

    pub async fn send_message(&self, channel_id: &str, text: &str, is_spoiler: bool) -> Result<()> {
        let url = format!("{}/api/messages", self.base_url);
        let mut req = self.client.post(&url).json(&serde_json::json!({
            "channel_id": channel_id,
            "content": text,
            "message_type": "text",
            "is_spoiler": is_spoiler
        }));

        if let Some(ref t) = self.token {
            req = req.bearer_auth(t);
        }

        let resp = req.send().await?;
        if !resp.status().is_success() {
            let error = resp.text().await.unwrap_or_default();
            anyhow::bail!("Failed to send message: {}", error);
        }

        Ok(())
    }
}
