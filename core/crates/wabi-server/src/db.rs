//! SpacetimeDB HTTP API client
//!
//! Based on the TypeScript backend's state-plane-stdb-http.mjs pattern

use anyhow::{Context, Result};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};

/// SpacetimeDB HTTP API client
pub struct StdbClient {
    client: Client,
    server: String,
    database: String,
    token: Option<String>,
    ingest_key_hash: Option<String>,
}

impl StdbClient {
    /// Create new SpacetimeDB client
    pub fn new(server: String, database: String, token: Option<String>) -> Self {
        let ingest_key_hash = std::env::var("WABI_INGEST_SECRET")
            .ok()
            .or_else(|| token.clone())
            .map(|secret| {
                use sha2::{Digest, Sha256};
                hex::encode(Sha256::digest(secret.as_bytes()))
            });

        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_default();

        Self {
            client,
            server,
            database,
            token,
            ingest_key_hash,
        }
    }

    /// Escape a string for use in STDB SQL to prevent injection.
    pub fn sanitize_sql(s: &str) -> String {
        s.replace('\'', "''")
    }

    /// Register the ingest key with STDB on startup.
    /// Safe to call on every boot — rotates if key changed, no-ops if same.
    pub async fn bootstrap_ingest_key(&self) -> Result<()> {
        let Some(ref new_hash) = self.ingest_key_hash else {
            return Ok(());
        };

        // Read the current stored hash to detect whether we need to set/rotate
        let current = self
            .sql_query("SELECT auth_key_hash FROM ingest_auth_config LIMIT 1")
            .await;

        let current_hash = current
            .ok()
            .and_then(|r| r.decode_rows().into_iter().next())
            .and_then(|row| {
                row.get("auth_key_hash")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            });

        if current_hash.as_deref() == Some(new_hash.as_str()) {
            return Ok(()); // already set correctly
        }

        // STDB Option<String> is an algebraic sum type: [0, "value"] = Some, [1, []] = None
        let prev_arg = if let Some(ref prev) = current_hash {
            json!([0, prev])
        } else {
            json!([1, []])
        };
        let args = json!([new_hash, prev_arg]);

        self.call_reducer_raw("set_ingest_key", &args)
            .await
            .context("Failed to bootstrap ingest key")?;

        tracing::info!("[stdb] ingest key registered");
        Ok(())
    }

    /// Clone the client (cheap, uses Arc internally for HTTP client)
    pub fn clone(&self) -> Self {
        Self {
            client: self.client.clone(),
            server: self.server.clone(),
            database: self.database.clone(),
            token: self.token.clone(),
            ingest_key_hash: self.ingest_key_hash.clone(),
        }
    }

    /// Seed default channels if none exist (first-boot)
    pub async fn seed_default_channels(&self) -> Result<()> {
        let existing = self.get_channels_raw().await.unwrap_or_default();
        if !existing.is_empty() {
            return Ok(());
        }

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        let defaults = vec![("general", "text"), ("voice", "voice")];

        for (id, kind) in defaults {
            let payload = json!({
                "row": {
                    "channel_id": id,
                    "name": id,
                    "channel_type": kind,
                    "created_at": now,
                    "created_by": "system",
                    "archived": false,
                    "min_role": "guest",
                }
            });
            self.ingest_event("channel", "create", &payload)
                .await
                .unwrap_or_else(|e| tracing::warn!("[stdb] failed to seed channel {}: {}", id, e));
        }

        tracing::info!("[stdb] seeded default channels: #general, #voice");
        Ok(())
    }

    /// Create a channel in STDB.
    pub async fn create_channel(
        &self,
        channel_id: &str,
        name: &str,
        channel_type: &str,
        created_by: i64,
    ) -> Result<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let payload = json!({
            "row": {
                "channel_id": channel_id,
                "name": name,
                "channel_type": channel_type,
                "created_at": now,
                "created_by": created_by.to_string(),
                "archived": false,
                "min_role": "member",
            }
        });
        self.ingest_event("channel", "create", &payload).await
    }

    /// Delete (archive) a channel in STDB.
    pub async fn delete_channel(&self, channel_id: &str) -> Result<()> {
        let payload = json!({ "row": { "channel_id": channel_id } });
        self.ingest_event("channel", "delete", &payload).await
    }

    /// Get all active users, returning their parsed row_json fields
    pub async fn get_all_users(&self) -> Result<Vec<std::collections::HashMap<String, Value>>> {
        let query =
            "SELECT row_json FROM state_user WHERE deleted = false AND active = true".to_string();
        let response = self.sql_query(&query).await?;
        let rows = response.decode_rows();

        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let row_json_str = row.get("row_json")?.as_str()?;
                let parsed: serde_json::Map<String, Value> =
                    serde_json::from_str(row_json_str).ok()?;
                Some(parsed.into_iter().collect())
            })
            .collect())
    }

    /// Get all channels, returning their parsed row_json fields
    pub async fn get_channels_raw(&self) -> Result<Vec<std::collections::HashMap<String, Value>>> {
        let query = "SELECT row_json FROM state_channel WHERE archived = false".to_string();
        let response = self.sql_query(&query).await?;
        let rows = response.decode_rows();

        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let row_json_str = row.get("row_json")?.as_str()?;
                let parsed: serde_json::Map<String, Value> =
                    serde_json::from_str(row_json_str).ok()?;
                Some(parsed.into_iter().collect())
            })
            .collect())
    }

    /// Get messages for a channel, returning their parsed row_json fields
    pub async fn get_messages_raw(
        &self,
        channel_id: &str,
        limit: u32,
    ) -> Result<Vec<std::collections::HashMap<String, Value>>> {
        let query = format!(
            "SELECT row_json FROM state_message WHERE channel_id = '{}' AND deleted = false LIMIT {}",
            Self::sanitize_sql(channel_id), limit
        );
        let response = self.sql_query(&query).await?;
        let rows = response.decode_rows();

        let mut msgs: Vec<_> = rows
            .into_iter()
            .filter_map(|row| {
                let row_json_str = row.get("row_json")?.as_str()?;
                let parsed: serde_json::Map<String, Value> =
                    serde_json::from_str(row_json_str).ok()?;
                Some(
                    parsed
                        .into_iter()
                        .collect::<std::collections::HashMap<String, Value>>(),
                )
            })
            .collect();

        msgs.sort_by_key(|m| m.get("created_at").and_then(|v| v.as_i64()).unwrap_or(0));
        Ok(msgs)
    }

    /// Get a user by username, parsing from row_json (username column is optional type in STDB)
    pub async fn get_user(
        &self,
        username: &str,
    ) -> Result<Vec<std::collections::HashMap<String, Value>>> {
        let query = "SELECT row_json FROM state_user WHERE deleted = false".to_string();
        let response = self.sql_query(&query).await?;
        let rows = response.decode_rows();

        let matching: Vec<_> = rows
            .into_iter()
            .filter_map(|row| {
                let row_json_str = row.get("row_json")?.as_str()?;
                let parsed: serde_json::Map<String, Value> =
                    serde_json::from_str(row_json_str).ok()?;
                let row_username = parsed.get("username")?.as_str()?;
                if row_username.eq_ignore_ascii_case(username) {
                    Some(parsed.into_iter().collect())
                } else {
                    None
                }
            })
            .collect();

        Ok(matching)
    }

    /// Create a new user via ingest_wabi_event
    pub async fn create_user(&self, username: &str, password_hash: &str) -> Result<i64> {
        let user_id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(1);

        let handle = username.to_lowercase();

        // All fields go directly in "row" — the bridge serializes the entire
        // row object as the stored row_json, so password_hash must be at top level.
        let payload = json!({
            "row": {
                "user_id": user_id,
                "username": username,
                "handle": handle,
                "password_hash": password_hash,
                "color": "#98D8C8",
                "is_active": true,
                "created_at": user_id,
            }
        });

        self.ingest_event("user", "create", &payload).await?;

        // Poll until STDB commit is visible — up to 5 attempts with backoff.
        for attempt in 0..5u32 {
            let delay = std::time::Duration::from_millis(100 * 2u64.pow(attempt));
            tokio::time::sleep(delay).await;
            let users = self.get_user(username).await.unwrap_or_default();
            if let Some(user) = users.first() {
                if let Some(id) = user.get("user_id").and_then(|v| v.as_i64()) {
                    return Ok(id);
                }
            }
        }
        Ok(user_id)
    }

    /// Create a guest user
    pub async fn create_guest_user(&self, username: &str) -> Result<i64> {
        let user_id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(-1);

        let handle = username.to_lowercase();

        let payload = json!({
            "row": {
                "user_id": user_id,
                "username": username,
                "handle": handle,
                "color": "#98D8C8",
                "is_active": true,
                "is_guest": true,
                "created_at": user_id,
            }
        });

        self.ingest_event("user", "create", &payload).await?;

        // Fetch the newly created guest user
        let users = self.get_user(username).await?;
        if let Some(user) = users.first() {
            if let Some(id) = user.get("user_id").and_then(|v| v.as_i64()) {
                return Ok(id);
            }
        }
        // Return negative ID as fallback for guests
        Ok(-1)
    }

    /// Get all channels
    #[allow(dead_code)]
    pub async fn get_channels(&self) -> Result<Vec<serde_json::Value>> {
        let query = "SELECT * FROM state_channel WHERE archived = false".to_string();
        let response = self.sql_query(&query).await?;
        let mut rows = response.decode_rows();
        rows.sort_by(|a, b| {
            let a_name = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let b_name = b.get("name").and_then(|v| v.as_str()).unwrap_or("");
            a_name.cmp(b_name)
        });

        Ok(rows
            .into_iter()
            .map(|row| serde_json::to_value(&row).unwrap())
            .collect())
    }

    /// Get messages for a channel
    #[allow(dead_code)]
    pub async fn get_messages(
        &self,
        channel_id: &str,
        limit: u32,
    ) -> Result<Vec<serde_json::Value>> {
        let query = format!(
            "SELECT * FROM state_message WHERE channel_id = '{}' AND deleted = false LIMIT {}",
            Self::sanitize_sql(channel_id),
            limit
        );
        let response = self.sql_query(&query).await?;
        let mut rows = response.decode_rows();
        rows.sort_by(|a, b| {
            let a_ts = a.get("created_at").and_then(|v| v.as_i64()).unwrap_or(0);
            let b_ts = b.get("created_at").and_then(|v| v.as_i64()).unwrap_or(0);
            a_ts.cmp(&b_ts)
        });

        Ok(rows
            .into_iter()
            .map(|row| serde_json::to_value(&row).unwrap())
            .collect())
    }

    /// Get all active webhooks
    #[allow(dead_code)]
    pub async fn get_webhooks(&self) -> Result<Vec<serde_json::Value>> {
        let query = "SELECT * FROM state_webhook WHERE is_active = true".to_string();
        let response = self.sql_query(&query).await?;
        let rows = response.decode_rows();

        Ok(rows
            .into_iter()
            .map(|row| serde_json::to_value(&row).unwrap())
            .collect())
    }

    /// Get all role definitions from state_role_definition table.
    pub async fn get_role_definitions(&self) -> Result<Vec<serde_json::Value>> {
        let query = "SELECT row_json FROM state_role_definition WHERE active = true".to_string();
        let response = self.sql_query(&query).await?;
        let rows = response.decode_rows();

        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let row_json_str = row.get("row_json")?.as_str()?;
                let parsed: serde_json::Value = serde_json::from_str(row_json_str).ok()?;
                Some(parsed)
            })
            .collect())
    }

    /// Upsert a role definition via the ingest_wabi_event reducer.
    /// The payload row fields match the frontend RoleDefinition interface:
    ///   roleName, displayName, priority, color, isHoisted
    /// plus workspaceId for the RBAC key.
    pub async fn upsert_role_definition(
        &self,
        workspace_id: &str,
        role_name: &str,
        display_name: &str,
        priority: i64,
        color: Option<&str>,
        is_hoisted: bool,
    ) -> Result<()> {
        let payload = json!({
            "row": {
                "workspace_id": workspace_id,
                "role_name": role_name,
                "display_name": display_name,
                "priority": priority,
                "color": color,
                "is_hoisted": is_hoisted,
            }
        });
        self.ingest_event("role_definition", "upsert", &payload).await
    }

    /// Get layout JSON and updated_at for a user
    pub async fn get_user_layout(&self, user_id: i64) -> Result<Option<(String, i64)>> {
        let q = format!(
            "SELECT layout_json, updated_at FROM state_layout_preferences WHERE user_id = {}",
            user_id
        );
        let resp = self.sql_query(&q).await?;
        let Some(row) = resp.decode_rows().into_iter().next() else { return Ok(None) };
        let layout_json = row.get("layout_json").and_then(|v| v.as_str()).map(String::from).unwrap_or_default();
        let updated_at = row.get("updated_at").and_then(|v| v.as_i64()).unwrap_or(0);
        Ok(Some((layout_json, updated_at)))
    }

    /// Upsert layout via ingest event
    pub async fn upsert_user_layout(&self, user_id: i64, layout_json: &str) -> Result<()> {
        self.ingest_event("layout", "upsert_layout", &json!({
            "row": { "user_id": user_id, "layout_json": layout_json }
        })).await
    }

    /// Check if a user is banned
    pub async fn is_user_banned(&self, user_id: i64) -> Result<bool> {
        let q = format!("SELECT active FROM state_ban WHERE user_id = {} LIMIT 1", user_id);
        let resp = self.sql_query(&q).await?;
        Ok(resp.decode_rows()
            .into_iter()
            .next()
            .and_then(|row| row.get("active").and_then(|v| v.as_bool()))
            .unwrap_or(false))
    }

    /// Ban a user
    pub async fn ban_user(&self, user_id: i64, banned_by: i64, reason: &str) -> Result<()> {
        self.ingest_event("ban", "ban", &json!({
            "row": { "user_id": user_id, "banned_by": banned_by, "reason": reason }
        })).await
    }

    /// Unban a user
    pub async fn unban_user(&self, user_id: i64) -> Result<()> {
        self.ingest_event("ban", "unban", &json!({
            "row": { "user_id": user_id }
        })).await
    }

    /// Check if a user is muted in a channel (or server-wide if channel_id is empty)
    pub async fn is_user_muted(&self, user_id: i64, channel_id: Option<&str>) -> Result<bool> {
        let ch_id = channel_id.unwrap_or("*");
        let q = format!("SELECT active FROM state_mute WHERE user_id = {} AND (channel_id = '{}' OR channel_id = '*') LIMIT 1", user_id, ch_id);
        let resp = self.sql_query(&q).await?;
        Ok(resp.decode_rows()
            .into_iter()
            .next()
            .and_then(|row| row.get("active").and_then(|v| v.as_bool()))
            .unwrap_or(false))
    }

    /// Mute a user
    pub async fn mute_user(&self, user_id: i64, channel_id: Option<&str>, muted_by: i64) -> Result<()> {
        let ch_id = channel_id.unwrap_or("");
        self.ingest_event("mute", "mute", &json!({
            "row": { "user_id": user_id, "channel_id": ch_id, "muted_by": muted_by }
        })).await
    }

    /// Unmute a user
    pub async fn unmute_user(&self, user_id: i64, channel_id: Option<&str>) -> Result<()> {
        let ch_id = channel_id.unwrap_or("");
        self.ingest_event("mute", "unmute", &json!({
            "row": { "user_id": user_id, "channel_id": ch_id }
        })).await
    }

    /// Check if a user is deafened in a channel (or server-wide if channel_id is empty)
    pub async fn is_user_deafened(&self, user_id: i64, channel_id: Option<&str>) -> Result<bool> {
        let ch_id = channel_id.unwrap_or("*");
        let q = format!("SELECT active FROM state_deafen WHERE user_id = {} AND (channel_id = '{}' OR channel_id = '*') LIMIT 1", user_id, ch_id);
        let resp = self.sql_query(&q).await?;
        Ok(resp.decode_rows()
            .into_iter()
            .next()
            .and_then(|row| row.get("active").and_then(|v| v.as_bool()))
            .unwrap_or(false))
    }

    /// Deafen a user
    pub async fn deafen_user(&self, user_id: i64, channel_id: Option<&str>, deafened_by: i64) -> Result<()> {
        let ch_id = channel_id.unwrap_or("");
        self.ingest_event("deafen", "deafen", &json!({
            "row": { "user_id": user_id, "channel_id": ch_id, "deafened_by": deafened_by }
        })).await
    }

    /// Undeafen a user
    pub async fn undeafen_user(&self, user_id: i64, channel_id: Option<&str>) -> Result<()> {
        let ch_id = channel_id.unwrap_or("");
        self.ingest_event("deafen", "undeafen", &json!({
            "row": { "user_id": user_id, "channel_id": ch_id, "deafened_by": 0 }
        })).await
    }

    /// Get channel auto-delete retention duration from row_json
    pub async fn get_channel_retention(&self, channel_id: &str) -> Result<Option<String>> {
        let q = format!(
            "SELECT row_json FROM state_channel WHERE channel_id = '{}'",
            Self::sanitize_sql(channel_id)
        );
        let resp = self.sql_query(&q).await?;
        let Some(row) = resp.decode_rows().into_iter().next() else { return Ok(None) };
        let retention = row.get("row_json")
            .and_then(|v| v.as_str())
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .and_then(|j| j.get("autoDeleteAfter").and_then(|v| v.as_str()).map(String::from));
        Ok(retention)
    }

    /// Add an emoji reaction to a message
    pub async fn add_reaction(&self, message_id: &str, channel_id: &str, user_id: i64, emoji_id: &str) -> Result<()> {
        self.ingest_event("reaction", "add", &json!({
            "row": { "message_id": message_id, "channel_id": channel_id, "user_id": user_id, "emoji_id": emoji_id }
        })).await
    }

    /// Remove an emoji reaction from a message
    pub async fn remove_reaction(&self, message_id: &str, user_id: i64, emoji_id: &str) -> Result<()> {
        self.ingest_event("reaction", "remove", &json!({
            "row": { "message_id": message_id, "user_id": user_id, "emoji_id": emoji_id }
        })).await
    }

    /// Get all reactions for a message
    pub async fn get_reactions(&self, message_id: &str) -> Result<Vec<Value>> {
        let query = format!(
            "SELECT user_id, emoji_id, created_at FROM state_reaction WHERE message_id = '{}'",
            Self::sanitize_sql(message_id)
        );
        let response = self.sql_query(&query).await?;
        let rows = response.decode_rows();
        let reactions = rows
            .into_iter()
            .map(|row| {
                json!({
                    "userId": row.get("user_id"),
                    "emojiId": row.get("emoji_id"),
                    "createdAt": row.get("created_at"),
                })
            })
            .collect();
        Ok(reactions)
    }

    /// Upsert an emote
    pub async fn upsert_emote(&self, emote_id: &str, name: &str, url: &str, emote_type: &str, created_by: i64) -> Result<()> {
        self.ingest_event("emote", "upsert", &json!({
            "row": { "emote_id": emote_id, "name": name, "url": url, "emote_type": emote_type, "created_by": created_by }
        })).await
    }

    /// Get all emotes
    pub async fn get_emotes(&self) -> Result<Vec<Value>> {
        let query = "SELECT emote_id, name, url, emote_type FROM state_emote";
        let response = self.sql_query(query).await?;
        let rows = response.decode_rows();
        let emotes = rows
            .into_iter()
            .map(|row| {
                json!({
                    "id": row.get("emote_id"),
                    "name": row.get("name"),
                    "url": row.get("url"),
                    "type": row.get("emote_type"),
                })
            })
            .collect();
        Ok(emotes)
    }

    /// Get emoji role rules for a message
    pub async fn get_emoji_role_rules(&self, message_id: &str) -> Result<Vec<Value>> {
        let query = format!(
            "SELECT emoji_id, role_name, remove_on_unreact FROM state_emoji_role_rule WHERE message_id = '{}' AND enabled = true",
            Self::sanitize_sql(message_id)
        );
        let response = self.sql_query(&query).await?;
        let rows = response.decode_rows();
        let rules = rows
            .into_iter()
            .map(|row| {
                json!({
                    "emojiId": row.get("emoji_id"),
                    "roleName": row.get("role_name"),
                    "removeOnUnreact": row.get("remove_on_unreact"),
                })
            })
            .collect();
        Ok(rules)
    }

    /// Execute SQL query against SpacetimeDB
    pub async fn sql_query(&self, query: &str) -> Result<StdbSqlResponse> {
        let url = format!("{}/v1/database/{}/sql", self.server, self.database);

        let mut req = self
            .client
            .post(&url)
            .header("Content-Type", "text/plain")
            .body(query.to_string());

        if let Some(token) = &self.token {
            req = req.bearer_auth(token);
        }

        let response = req
            .send()
            .await
            .context("Failed to send SQL query to SpacetimeDB")?;

        if !response.status().is_success() {
            let error = response.text().await.unwrap_or_default();
            anyhow::bail!("SpacetimeDB query failed: {}", error);
        }

        let results: Vec<StdbSqlResponse> = response
            .json()
            .await
            .context("Failed to parse SpacetimeDB response")?;

        results
            .into_iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!("SpacetimeDB returned empty result set"))
    }

    /// Call a reducer
    pub async fn call_reducer(&self, reducer_name: &str, args: &[Value]) -> Result<()> {
        let url = format!(
            "{}/v1/database/{}/call/{}",
            self.server, self.database, reducer_name
        );

        let mut req = self.client.post(&url).json(args);

        if let Some(token) = &self.token {
            req = req.bearer_auth(token);
        }

        let response = req.send().await.context("Failed to call reducer")?;

        if !response.status().is_success() {
            let error = response.text().await.unwrap_or_default();
            anyhow::bail!("SpacetimeDB reducer call failed: {}", error);
        }

        Ok(())
    }

    /// Call ingest_wabi_event reducer to persist events to STDB
    pub async fn ingest_event(&self, entity: &str, operation: &str, payload: &Value) -> Result<()> {
        let mut event = json!({
            "entity": entity,
            "operation": operation,
            "payload": payload,
        });
        if let Some(ref hash) = self.ingest_key_hash {
            event["authKey"] = Value::String(hash.clone());
        }
        let event_json = serde_json::to_string(&event).context("Failed to serialize event")?;
        tracing::info!(
            "Calling ingest_wabi_event: entity={} op={} payload={}",
            entity,
            operation,
            event_json
        );
        let result = self
            .call_reducer("ingest_wabi_event", &[Value::String(event_json)])
            .await;
        if let Err(ref e) = result {
            tracing::error!("Reducer call failed: {}", e);
        } else {
            tracing::info!("Reducer call succeeded");
        }
        result
    }

    /// Call a reducer with a pre-built JSON args array (for internal use)
    async fn call_reducer_raw(&self, reducer_name: &str, args: &Value) -> Result<()> {
        let url = format!(
            "{}/v1/database/{}/call/{}",
            self.server, self.database, reducer_name
        );
        let mut req = self.client.post(&url).json(args);
        if let Some(token) = &self.token {
            req = req.bearer_auth(token);
        }
        let response = req.send().await.context("Failed to call reducer")?;
        if !response.status().is_success() {
            let error = response.text().await.unwrap_or_default();
            anyhow::bail!("Reducer {} failed: {}", reducer_name, error);
        }
        Ok(())
    }

    /// Upsert a user via reducer
    #[allow(dead_code)]
    pub async fn upsert_user(
        &self,
        user_id: i64,
        username: &str,
        handle: Option<&str>,
        color: &str,
    ) -> Result<()> {
        let payload = json!({
            "user_id": user_id,
            "username": username,
            "handle": handle,
            "color": color,
            "active": true,
            "deleted": false
        });
        self.ingest_event("user", "upsert", &payload).await
    }

    /// Upsert a message via reducer.
    /// The STDB reducer's `apply_message_upsert` reads from `payload.row.*` and
    /// stores the whole `row` object as `row_json`. Payloads without a `row` wrapper
    /// fail the `message_id` guard and silently return without inserting.
    pub async fn upsert_message(
        &self,
        message_id: &str,
        channel_id: &str,
        sender_id: i64,
        sender_username: &str,
        content: &str,
        timestamp: i64,
    ) -> Result<()> {
        let payload = json!({
            "row": {
                "message_id":      message_id,
                "channel_id":      channel_id,
                "sender_id":       sender_id.to_string(),
                "sender_username": sender_username,
                "content":         content,
                "created_at":      timestamp,
                "deleted":         false,
            }
        });
        self.ingest_event("message", "create", &payload).await
    }

    /// Soft-delete a message by setting deleted=true via reducer.
    /// Get a message by ID, returning sender_id if found
    pub async fn get_message_sender(&self, message_id: &str) -> Result<Option<String>> {
        let query = format!(
            "SELECT sender_id FROM state_message WHERE message_id = '{}'",
            Self::sanitize_sql(message_id)
        );
        let response = self.sql_query(&query).await?;
        if let Some(row) = response.decode_rows().into_iter().next() {
            if let Some(sender_id_val) = row.get("sender_id") {
                if let Some(sender_id) = sender_id_val.as_str() {
                    return Ok(Some(sender_id.to_string()));
                }
            }
        }
        Ok(None)
    }

    pub async fn delete_message(&self, message_id: &str) -> Result<()> {
        let payload = json!({
            "row": {
                "message_id": message_id,
            }
        });
        self.ingest_event("message", "delete", &payload).await
    }

    /// Edit a message by updating its content and setting is_edited=true via reducer.
    pub async fn edit_message(&self, message_id: &str, new_content: &str) -> Result<()> {
        let payload = json!({
            "row": {
                "message_id": message_id,
                "content": new_content,
                "is_edited": true,
            }
        });
        self.ingest_event("message", "update", &payload).await
    }

    /// Create a DM channel via reducer.
    pub async fn create_dm_channel(
        &self,
        channel_id: &str,
        name: &str,
        members: &[String],
        created_by: i64,
    ) -> Result<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let payload = json!({
            "row": {
                "channel_id": channel_id,
                "name": name,
                "channel_type": "dm",
                "created_at": now,
                "created_by": created_by.to_string(),
                "archived": false,
                "min_role": "member",
                "members": members,
            }
        });
        self.ingest_event("channel", "create", &payload).await
    }

    /// Delete (archive) a DM channel via reducer.
    pub async fn delete_dm_channel(&self, channel_id: &str) -> Result<()> {
        let payload = json!({ "row": { "channel_id": channel_id } });
        self.ingest_event("channel", "delete", &payload).await
    }

    /// Upsert a channel (group) via reducer — used for add-group-member and update-group-avatar.
    #[allow(dead_code)]
    pub async fn upsert_group(
        &self,
        channel_id: &str,
        name: &str,
        channel_type: &str,
        members: Option<&[String]>,
        avatar: Option<&str>,
        description: Option<&str>,
    ) -> Result<()> {
        let mut row = serde_json::Map::new();
        row.insert("channel_id".to_string(), serde_json::Value::String(channel_id.to_string()));
        row.insert("name".to_string(), serde_json::Value::String(name.to_string()));
        row.insert("channel_type".to_string(), serde_json::Value::String(channel_type.to_string()));
        row.insert("archived".to_string(), serde_json::Value::Bool(false));
        row.insert("min_role".to_string(), serde_json::Value::String("member".to_string()));
        if let Some(m) = members {
            row.insert("members".to_string(), serde_json::to_value(m).unwrap());
        }
        if let Some(a) = avatar {
            row.insert("avatar".to_string(), serde_json::Value::String(a.to_string()));
        }
        if let Some(d) = description {
            row.insert("description".to_string(), serde_json::Value::String(d.to_string()));
        }
        let payload = json!({ "row": row });
        self.ingest_event("channel", "upsert", &payload).await
    }

    /// Upsert a channel via reducer
    #[allow(dead_code)]
    pub async fn upsert_channel(
        &self,
        channel_id: &str,
        name: &str,
        channel_type: &str,
        description: Option<&str>,
    ) -> Result<()> {
        let payload = json!({
            "channel_id": channel_id,
            "name": name,
            "channel_type": channel_type,
            "description": description,
            "archived": false
        });
        self.ingest_event("channel", "create", &payload).await
    }
}

/// SpacetimeDB SQL response
#[derive(Debug, Deserialize)]
pub struct StdbSqlResponse {
    pub schema: Option<StdbSchema>,
    pub rows: Option<Vec<Vec<Value>>>,
}

/// SpacetimeDB schema
#[derive(Debug, Deserialize)]
pub struct StdbSchema {
    pub elements: Option<Vec<StdbSchemaElement>>,
}

/// SpacetimeDB schema element
#[derive(Debug, Deserialize)]
pub struct StdbSchemaElement {
    pub name: Option<StdbName>,
}

/// SpacetimeDB name wrapper
#[derive(Debug, Deserialize)]
pub struct StdbName {
    pub some: Option<String>,
}

impl StdbSqlResponse {
    /// Decode rows into key-value maps
    pub fn decode_rows(&self) -> Vec<std::collections::HashMap<String, Value>> {
        let mut result = Vec::new();

        if let Some(ref schema) = self.schema {
            if let Some(ref elements) = schema.elements {
                let names: Vec<String> = elements
                    .iter()
                    .enumerate()
                    .map(|(i, e)| {
                        e.name
                            .as_ref()
                            .and_then(|n| n.some.clone())
                            .unwrap_or_else(|| format!("col_{}", i))
                    })
                    .collect();

                if let Some(ref rows) = self.rows {
                    for row in rows {
                        let mut map = std::collections::HashMap::new();
                        for (i, value) in row.iter().enumerate() {
                            if i < names.len() {
                                map.insert(names[i].clone(), value.clone());
                            }
                        }
                        result.push(map);
                    }
                }
            }
        }

        result
    }
}
