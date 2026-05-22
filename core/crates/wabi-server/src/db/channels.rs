use anyhow::Result;
use serde_json::{json, Value};

use super::StdbClient;

impl StdbClient {
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
