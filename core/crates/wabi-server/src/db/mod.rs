//! SpacetimeDB HTTP API client
//!
//! Based on the TypeScript backend's state-plane-stdb-http.mjs pattern

mod channels;
mod content;
mod messages;
mod moderation;
mod users;

use anyhow::{Context, Result};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};

pub use channels::*;
pub use content::*;
pub use messages::*;
pub use moderation::*;
pub use users::*;

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
            return Ok(());
        }

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
        self.ingest_event("role_definition", "upsert", &payload)
            .await
    }

    /// Get layout JSON and updated_at for a user
    pub async fn get_user_layout(&self, user_id: i64) -> Result<Option<(String, i64)>> {
        let q = format!(
            "SELECT layout_json, updated_at FROM state_layout_preferences WHERE user_id = {}",
            user_id
        );
        let resp = self.sql_query(&q).await?;
        let Some(row) = resp.decode_rows().into_iter().next() else {
            return Ok(None);
        };
        let layout_json = row
            .get("layout_json")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_default();
        let updated_at = row.get("updated_at").and_then(|v| v.as_i64()).unwrap_or(0);
        Ok(Some((layout_json, updated_at)))
    }

    /// Upsert layout via ingest event
    pub async fn upsert_user_layout(&self, user_id: i64, layout_json: &str) -> Result<()> {
        self.ingest_event(
            "layout",
            "upsert_layout",
            &json!({
                "row": { "user_id": user_id, "layout_json": layout_json }
            }),
        )
        .await
    }

    /// Get channel auto-delete retention duration from row_json
    pub async fn get_channel_retention(&self, channel_id: &str) -> Result<Option<String>> {
        let q = format!(
            "SELECT row_json FROM state_channel WHERE channel_id = '{}'",
            Self::sanitize_sql(channel_id)
        );
        let resp = self.sql_query(&q).await?;
        let Some(row) = resp.decode_rows().into_iter().next() else {
            return Ok(None);
        };
        let retention = row
            .get("row_json")
            .and_then(|v| v.as_str())
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .and_then(|j| {
                j.get("autoDeleteAfter")
                    .and_then(|v| v.as_str())
                    .map(String::from)
            });
        Ok(retention)
    }

    /// Export current live-state rows for a standby snapshot.
    ///
    /// This returns plaintext rows in memory only. Callers must encrypt the
    /// resulting payload before writing it to disk or sending it over the
    /// network. Table names are allowlisted to avoid exporting transient logs,
    /// leases, call signaling, or historical ingest tables.
    pub async fn export_live_state_snapshot_rows(
        &self,
    ) -> Result<crate::standby::LiveStateSnapshotPayload> {
        let mut tables = std::collections::BTreeMap::new();

        for table in crate::standby::LIVE_STATE_SNAPSHOT_TABLES {
            if !crate::standby::is_live_state_snapshot_table(table)
                || crate::standby::is_excluded_snapshot_table(table)
            {
                anyhow::bail!("refusing to export non-live-state table: {}", table);
            }

            let query = format!("SELECT * FROM {}", table);
            let response = self.sql_query(&query).await?;
            let rows = response
                .decode_rows()
                .into_iter()
                .map(|row| serde_json::to_value(row).unwrap_or(Value::Null))
                .collect::<Vec<_>>();
            tables.insert((*table).to_string(), rows);
        }

        Ok(crate::standby::LiveStateSnapshotPayload { tables })
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
