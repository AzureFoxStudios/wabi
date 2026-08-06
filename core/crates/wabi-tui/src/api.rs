//! Wabi API client — chat + admin power-user endpoints.

use anyhow::{Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::app::{Channel, Message, RegisteredUser, ServerStats};

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
    #[serde(default)]
    highest_role: Option<String>,
    #[serde(default, rename = "highestRole")]
    highest_role_camel: Option<String>,
}

#[derive(Debug)]
pub struct LoginResult {
    pub token: String,
    pub user_id: i64,
    pub username: String,
    pub highest_role: Option<String>,
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
    #[serde(default, rename = "type")]
    type_alt: Option<String>,
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
    #[serde(default)]
    user_id: serde_json::Value,
    #[serde(default)]
    username: String,
    #[serde(default)]
    content: String,
    #[serde(default)]
    message_type: String,
    #[serde(default)]
    created_at: i64,
    #[serde(default, rename = "createdAt")]
    created_at_camel: Option<i64>,
}

#[derive(Deserialize)]
struct RegisteredUserRow {
    #[serde(default, rename = "userId")]
    user_id: i64,
    #[serde(default)]
    username: String,
    #[serde(default, rename = "profilePicture")]
    profile_picture: Option<String>,
    #[serde(default)]
    color: Option<String>,
}

#[derive(Deserialize)]
struct DashboardStatsResponse {
    overview: StatsOverview,
}

#[derive(Deserialize)]
struct StatsOverview {
    #[serde(default, rename = "totalUsers")]
    total_users: u64,
    #[serde(default, rename = "onlineUsers")]
    online_users: u64,
    #[serde(default, rename = "bannedUsers")]
    banned_users: u64,
    #[serde(default, rename = "mutedUsers")]
    muted_users: u64,
    #[serde(default, rename = "totalChannels")]
    total_channels: u64,
    #[serde(default, rename = "totalRoles")]
    total_roles: u64,
    #[serde(default, rename = "totalEmojis")]
    total_emojis: u64,
    #[serde(default, rename = "totalMessages")]
    total_messages: u64,
    #[serde(default, rename = "openReports")]
    open_reports: u64,
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

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn set_token(&mut self, token: String) {
        self.token = Some(token);
    }

    pub fn clear_token(&mut self) {
        self.token = None;
    }

    fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if let Some(ref t) = self.token {
            req.bearer_auth(t)
        } else {
            req
        }
    }

    pub async fn health(&self) -> Result<String> {
        let url = format!("{}/health", self.base_url);
        let resp = self.client.get(&url).send().await?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if status.is_success() {
            Ok(if body.trim().is_empty() {
                "ok".into()
            } else {
                body.chars().take(200).collect()
            })
        } else {
            anyhow::bail!("Server returned {status}: {body}");
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
            anyhow::bail!("Login failed: {error}");
        }

        let data: LoginResponse = resp
            .json()
            .await
            .context("Failed to parse login response")?;
        let token = data
            .token
            .ok_or_else(|| anyhow::anyhow!("No token in response"))?;
        let (user_id, uname, role) = data
            .user
            .map(|u| {
                (
                    u.id,
                    u.username,
                    u.highest_role.or(u.highest_role_camel),
                )
            })
            .unwrap_or((0, username.to_string(), None));
        Ok(LoginResult {
            token,
            user_id,
            username: uname,
            highest_role: role,
        })
    }

    pub async fn get_channels(&self) -> Result<Vec<Channel>> {
        let url = format!("{}/api/channels", self.base_url);
        let resp = self.auth(self.client.get(&url)).send().await?;
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
                channel_type: if c.channel_type.is_empty() {
                    c.type_alt.unwrap_or_else(|| "text".into())
                } else {
                    c.channel_type
                },
                description: c.description,
            })
            .collect())
    }

    pub async fn get_messages(&self, channel_id: &str, limit: u32) -> Result<Vec<Message>> {
        let url = format!(
            "{}/api/messages/{}?limit={}",
            self.base_url, channel_id, limit
        );
        let resp = self.auth(self.client.get(&url)).send().await?;
        if !resp.status().is_success() {
            anyhow::bail!("Messages request failed: {}", resp.status());
        }
        let data: MessagesResponse = resp.json().await.context("Failed to parse messages")?;

        Ok(data
            .messages
            .into_iter()
            .map(|m| {
                let uid = match &m.user_id {
                    serde_json::Value::String(s) => s.clone(),
                    serde_json::Value::Number(n) => n.to_string(),
                    _ => String::new(),
                };
                let display_name = if !m.username.is_empty() {
                    m.username.clone()
                } else {
                    uid.clone()
                };
                let ts = m.created_at_camel.unwrap_or(m.created_at);
                Message {
                    id: m.id,
                    channel_id: m.channel_id,
                    sender_id: uid.parse::<i64>().unwrap_or(0),
                    sender_name: display_name,
                    text: m.content,
                    timestamp: ts,
                    message_type: m.message_type,
                }
            })
            .collect())
    }

    pub async fn send_message(&self, channel_id: &str, text: &str, is_spoiler: bool) -> Result<()> {
        let url = format!("{}/api/messages", self.base_url);
        let req = self.auth(self.client.post(&url)).json(&serde_json::json!({
            "channel_id": channel_id,
            "content": text,
            "message_type": "text",
            "is_spoiler": is_spoiler
        }));

        let resp = req.send().await?;
        if !resp.status().is_success() {
            let error = resp.text().await.unwrap_or_default();
            anyhow::bail!("Failed to send message: {error}");
        }
        Ok(())
    }

    pub async fn list_users(&self) -> Result<Vec<RegisteredUser>> {
        let url = format!("{}/api/users", self.base_url);
        let resp = self.auth(self.client.get(&url)).send().await?;
        if !resp.status().is_success() {
            anyhow::bail!("Users request failed: {}", resp.status());
        }
        // Accept either bare array or wrapped object
        let body: serde_json::Value = resp.json().await.context("parse users")?;
        let rows: Vec<RegisteredUserRow> = if let Some(arr) = body.as_array() {
            serde_json::from_value(serde_json::Value::Array(arr.clone()))?
        } else if let Some(users) = body.get("users") {
            serde_json::from_value(users.clone())?
        } else {
            serde_json::from_value(body)?
        };
        Ok(rows
            .into_iter()
            .map(|u| RegisteredUser {
                user_id: u.user_id,
                username: u.username,
                profile_picture: u.profile_picture,
                color: u.color.unwrap_or_else(|| "#6366f1".into()),
            })
            .collect())
    }

    pub async fn admin_stats(&self) -> Result<ServerStats> {
        let url = format!("{}/api/admin/stats", self.base_url);
        let resp = self.auth(self.client.get(&url)).send().await?;
        if !resp.status().is_success() {
            let t = resp.text().await.unwrap_or_default();
            anyhow::bail!("Admin stats failed: {t}");
        }
        let data: DashboardStatsResponse = resp.json().await.context("parse admin stats")?;
        Ok(ServerStats {
            total_users: data.overview.total_users,
            online_users: data.overview.online_users,
            banned_users: data.overview.banned_users,
            muted_users: data.overview.muted_users,
            total_channels: data.overview.total_channels,
            total_roles: data.overview.total_roles,
            total_emojis: data.overview.total_emojis,
            total_messages: data.overview.total_messages,
            open_reports: data.overview.open_reports,
        })
    }

    pub async fn admin_reset_password(
        &self,
        target_user_id: i64,
        new_password: &str,
        temporary: bool,
    ) -> Result<()> {
        let url = format!("{}/api/admin/users/reset-password", self.base_url);
        let resp = self
            .auth(self.client.post(&url))
            .json(&serde_json::json!({
                "targetUserId": target_user_id,
                "newPassword": new_password,
                "temporary": temporary
            }))
            .send()
            .await?;
        if !resp.status().is_success() {
            let t = resp.text().await.unwrap_or_default();
            anyhow::bail!("Reset password failed: {t}");
        }
        Ok(())
    }

    pub async fn admin_clear_lockout(&self, target_user_id: i64) -> Result<()> {
        let url = format!("{}/api/admin/users/clear-login-lockout", self.base_url);
        let resp = self
            .auth(self.client.post(&url))
            .json(&serde_json::json!({ "targetUserId": target_user_id }))
            .send()
            .await?;
        if !resp.status().is_success() {
            let t = resp.text().await.unwrap_or_default();
            anyhow::bail!("Clear lockout failed: {t}");
        }
        Ok(())
    }
}
