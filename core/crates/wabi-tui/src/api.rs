//! Wabi API client — chat + admin power-user endpoints.

use anyhow::{Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::app::{Channel, Message, RegisteredUser, ServerStats};

/// Parsed channel type from the server. `Other` is reserved for any
/// future/unknown kind; the parser always yields a known variant so this
/// is only reachable via direct construction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum ChannelKind {
    Text,
    Dm,
    Group,
    Voice,
    Lore,
    Whiteboard,
    Announcement,
    Planning,
    Wiki,
    Forum,
    Gallery,
    Incident,
    Reception,
    /// Category containers are hidden from the list, not selectable.
    Category,
    Other,
}

impl ChannelKind {
    /// Parse from the server's `channel_type` string. Empty or unknown
    /// values fall back to `Text`.
    pub fn from_type(s: &str) -> Self {
        match s {
            "text" => ChannelKind::Text,
            "dm" => ChannelKind::Dm,
            "group" => ChannelKind::Group,
            "voice" => ChannelKind::Voice,
            "lore" => ChannelKind::Lore,
            "whiteboard" => ChannelKind::Whiteboard,
            "announcement" => ChannelKind::Announcement,
            "planning" => ChannelKind::Planning,
            "wiki" => ChannelKind::Wiki,
            "forum" => ChannelKind::Forum,
            "gallery" => ChannelKind::Gallery,
            "incident" => ChannelKind::Incident,
            "reception" => ChannelKind::Reception,
            "category" => ChannelKind::Category,
            _ => ChannelKind::Other,
        }
    }

    /// Short, subtle badge rendered before the channel name in the list.
    pub fn badge(&self) -> &'static str {
        match self {
            ChannelKind::Text => "#",
            ChannelKind::Dm => "@",
            ChannelKind::Group => "G:",
            ChannelKind::Voice => "mic:",
            ChannelKind::Lore => "book:",
            ChannelKind::Whiteboard => "wb:",
            ChannelKind::Announcement => "ann:",
            ChannelKind::Planning => "plan:",
            ChannelKind::Wiki => "wiki:",
            ChannelKind::Forum => "forum:",
            ChannelKind::Gallery => "gal:",
            ChannelKind::Incident => "inc:",
            ChannelKind::Reception => "desk:",
            // Categories are containers, not surfaces; hidden from the list.
            ChannelKind::Category => "",
            ChannelKind::Other => "#",
        }
    }

    /// Surfaces the TUI can actually render as a message stream today.
    pub fn is_text_like(&self) -> bool {
        matches!(
            self,
            ChannelKind::Text
                | ChannelKind::Dm
                | ChannelKind::Group
                | ChannelKind::Announcement
                | ChannelKind::Other
        )
    }
}

#[derive(Debug, Clone)]
pub struct ApiClient {
    base_url: String,
    client: Client,
    token: Option<String>,
}

/// Lore repo state for one channel (from GET /api/addons/lore/repos/{id}).
#[derive(Debug, Clone)]
pub struct LoreRepoInfo {
    pub channel_id: i64,
    pub repo_name: String,
    pub lore_server_url: String,
    /// "native" or "mirror" — normalized from the wire's string-or-object
    /// shape at this boundary (same contract as the web client).
    pub class: String,
    pub imported_from: Option<String>,
}

impl LoreRepoInfo {
    fn from_json(body: &serde_json::Value) -> Self {
        let as_str = |v: &serde_json::Value| v.as_str().map(str::to_ascii_lowercase);
        let class = match &body["class"] {
            // Wire shapes seen in the wild: "Native", "Mirror", and the
            // tagged-object form {"type":"native"}.
            serde_json::Value::String(s) => {
                if s.eq_ignore_ascii_case("mirror") {
                    "mirror"
                } else {
                    "native"
                }
            }
            serde_json::Value::Object(o) => match as_str(
                o.get("type")
                    .or_else(|| o.values().next())
                    .unwrap_or(&serde_json::Value::Null),
            )
            .as_deref()
            {
                Some("mirror") => "mirror",
                _ => "native",
            },
            _ => "native",
        }
        .to_string();
        LoreRepoInfo {
            channel_id: body["channel_id"].as_i64().unwrap_or(0),
            repo_name: body["repo_name"].as_str().unwrap_or("default").to_string(),
            lore_server_url: body["lore_server_url"]
                .as_str()
                .unwrap_or("lore://localhost:10000")
                .to_string(),
            class,
            imported_from: body["imported_from"].as_str().map(str::to_string),
        }
    }
}

/// A file inside a lore repo.
#[derive(Debug, Clone)]
pub struct LoreFile {
    pub path: String,
    pub size: u64,
    pub status: String,
}

/// Client-side mirror of the server's repo-name slug (wabi_lore::slugify_repo_name):
/// lowercase `[a-z0-9-]`, separator runs collapsed. Empty output tells the
/// caller to fall back to `ch-{id}`.
pub fn slugify(input: &str) -> String {
    let mut slug = String::with_capacity(input.len());
    let mut pending_dash = false;
    for c in input.chars() {
        if c.is_ascii_alphanumeric() {
            if pending_dash && !slug.is_empty() {
                slug.push('-');
            }
            pending_dash = false;
            slug.push(c.to_ascii_lowercase());
        } else {
            pending_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    slug
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
    #[serde(default)]
    extra: serde_json::Value,
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
            .map(|u| (u.id, u.username, u.highest_role.or(u.highest_role_camel)))
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
            .map(|c| {
                let channel_type = if c.channel_type.is_empty() {
                    c.type_alt.unwrap_or_else(|| "text".into())
                } else {
                    c.channel_type
                };
                let kind = ChannelKind::from_type(&channel_type);
                Channel {
                    id: c.id,
                    name: c.name,
                    channel_type,
                    kind,
                    description: c.description,
                }
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
        // Extended counters live in the server's `extra` object; tolerate
        // older servers that omit it.
        let extra: &serde_json::Value = &data.extra;
        let channels_by_kind = extra
            .get("channelsByKind")
            .and_then(|v| v.as_object())
            .map(|m| {
                let mut pairs: Vec<(String, u64)> = m
                    .iter()
                    .filter_map(|(k, v)| v.as_u64().map(|n| (k.clone(), n)))
                    .collect();
                pairs.sort_by(|a, b| b.1.cmp(&a.1));
                pairs
            })
            .unwrap_or_default();
        let u64_at = |key: &str| extra.get(key).and_then(|v| v.as_u64());
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
            registered_users: u64_at("registeredUsers"),
            bot_users: u64_at("botUsers"),
            active_users: u64_at("activeUsers"),
            users_seen_24h: u64_at("usersSeenLast24h"),
            channels_by_kind,
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

    // -- Lore: channel-as-repo setup + browsing --

    /// Parse a wire channel id (`ch_2f`) into the numeric id the lore API
    /// routes expect. Same contract as the web client's parseLoreChannelId.
    pub fn parse_channel_id(wire: &str) -> Option<i64> {
        wire.strip_prefix("ch_")
            .and_then(|hex| i64::from_str_radix(hex, 16).ok())
    }

    pub async fn create_channel(&self, name: &str, channel_type: &str) -> Result<Channel> {
        let url = format!("{}/api/channels", self.base_url);
        let resp = self
            .auth(self.client.post(&url))
            .json(&serde_json::json!({ "name": name, "channel_type": channel_type }))
            .send()
            .await?;
        let status = resp.status();
        let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
        if !status.is_success() {
            let err = body["error"].as_str().unwrap_or("unknown error");
            anyhow::bail!("Create channel failed ({status}): {err}");
        }
        let id = body["id"].as_str().unwrap_or_default().to_string();
        if id.is_empty() {
            anyhow::bail!("Create channel response missing id: {body}");
        }
        let ctype = body["type"]
            .as_str()
            .or_else(|| body["channel_type"].as_str())
            .unwrap_or(channel_type)
            .to_string();
        Ok(Channel {
            kind: ChannelKind::from_type(&ctype),
            id,
            name: body["name"].as_str().unwrap_or(name).to_string(),
            channel_type: ctype,
            description: None,
        })
    }

    pub async fn lore_health(&self) -> Result<serde_json::Value> {
        let url = format!("{}/api/addons/lore/health", self.base_url);
        let resp = self.auth(self.client.get(&url)).send().await?;
        let status = resp.status();
        let body: serde_json::Value = resp
            .json()
            .await
            .unwrap_or(serde_json::json!({ "status": "unparseable" }));
        if !status.is_success() {
            anyhow::bail!("Lore health check failed ({status})");
        }
        Ok(body)
    }

    /// GET /repos/{id} — 404 maps to Ok(None) (channel without a repo).
    pub async fn lore_get_repo(&self, channel_id: i64) -> Result<Option<LoreRepoInfo>> {
        let url = format!("{}/api/addons/lore/repos/{channel_id}", self.base_url);
        let resp = self.auth(self.client.get(&url)).send().await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let status = resp.status();
        let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
        if !status.is_success() {
            anyhow::bail!("Lore repo fetch failed ({status})");
        }
        Ok(Some(LoreRepoInfo::from_json(&body)))
    }

    pub async fn lore_create_repo(&self, channel_id: i64, repo_name: &str) -> Result<LoreRepoInfo> {
        let url = format!("{}/api/addons/lore/repos", self.base_url);
        let resp = self
            .auth(self.client.post(&url))
            .json(&serde_json::json!({ "channelId": channel_id, "repoName": repo_name }))
            .send()
            .await?;
        let status = resp.status();
        let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
        if !status.is_success() {
            let err = body["error"].as_str().unwrap_or("unknown error");
            anyhow::bail!("Lore repo create failed ({status}): {err}");
        }
        Ok(LoreRepoInfo::from_json(&body))
    }

    /// Import a git repo (URL or local path) into a channel's lore repo.
    /// The server adopts an empty auto-created repo; a repo with content 409s.
    pub async fn lore_import(
        &self,
        channel_id: i64,
        name: &str,
        upstream: &str,
    ) -> Result<LoreRepoInfo> {
        let url = format!("{}/api/addons/lore/repos/import", self.base_url);
        let resp = self
            .auth(self.client.post(&url))
            .json(&serde_json::json!({
                "channel_id": channel_id,
                "upstream_url": upstream,
                "name": name,
            }))
            .send()
            .await?;
        let status = resp.status();
        let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
        if !status.is_success() {
            let err = body["error"].as_str().unwrap_or("unknown error");
            anyhow::bail!("Lore import failed ({status}): {err}");
        }
        Ok(LoreRepoInfo::from_json(&body))
    }

    pub async fn lore_list_files(&self, channel_id: i64) -> Result<Vec<LoreFile>> {
        let url = format!("{}/api/addons/lore/repos/{channel_id}/files", self.base_url);
        let resp = self.auth(self.client.get(&url)).send().await?;
        let status = resp.status();
        let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
        if !status.is_success() {
            anyhow::bail!("Lore file list failed ({status})");
        }
        let mut files: Vec<LoreFile> = Vec::new();
        if let Some(arr) = body.as_array() {
            for f in arr {
                files.push(LoreFile {
                    path: f["path"].as_str().unwrap_or_default().to_string(),
                    size: f["size"].as_u64().unwrap_or(0),
                    status: f["status"].as_str().unwrap_or("clean").to_string(),
                });
            }
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(files)
    }

    /// Stage a file (batch push) without committing — the whole batch is
    /// sealed with one `lore_snapshot` afterwards.
    pub async fn lore_stage(&self, channel_id: i64, repo_path: &str, bytes: Vec<u8>) -> Result<u64> {
        let path = encode_repo_path(repo_path);
        let url = format!(
            "{}/api/addons/lore/repos/{channel_id}/files/{path}?stageOnly=true",
            self.base_url
        );
        let resp = self
            .auth(self.client.put(&url))
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .body(bytes)
            .send()
            .await?;
        let status = resp.status();
        let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
        if !status.is_success() {
            let err = body["error"].as_str().unwrap_or("unknown error");
            anyhow::bail!("stage {repo_path} failed ({status}): {err}");
        }
        Ok(body["file"]["size"].as_u64().unwrap_or(0))
    }

    /// Seal a staged batch with a single commit; returns the revision hash.
    pub async fn lore_snapshot(&self, channel_id: i64, message: &str) -> Result<String> {
        let url = format!("{}/api/addons/lore/repos/{channel_id}/snapshot", self.base_url);
        let resp = self
            .auth(self.client.post(&url))
            .json(&serde_json::json!({ "message": message }))
            .send()
            .await?;
        let status = resp.status();
        let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
        if !status.is_success() {
            let err = body["error"].as_str().unwrap_or("unknown error");
            anyhow::bail!("Lore snapshot failed ({status}): {err}");
        }
        Ok(body["revision"]["hash"]
            .as_str()
            .unwrap_or_default()
            .to_string())
    }

    /// Download a file's bytes (head revision) — used for text previews.
    pub async fn lore_download(&self, channel_id: i64, repo_path: &str) -> Result<Vec<u8>> {
        let path = encode_repo_path(repo_path);
        let url = format!(
            "{}/api/addons/lore/repos/{channel_id}/files/{path}",
            self.base_url
        );
        let resp = self.auth(self.client.get(&url)).send().await?;
        let status = resp.status();
        if !status.is_success() {
            anyhow::bail!("download {repo_path} failed ({status})");
        }
        Ok(resp.bytes().await?.to_vec())
    }
}

/// Percent-encode a repo path for a URL segment: keep `/` and unreserved
/// chars, escape everything else (spaces, `#`, `?`, non-ASCII, …).
fn encode_repo_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for b in path.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
