use anyhow::Result;
use serde_json::json;

use super::StdbClient;

impl StdbClient {
    /// Get messages for a channel, returning their parsed row_json fields
    pub async fn get_messages_raw(
        &self,
        channel_id: &str,
        limit: u32,
    ) -> Result<Vec<std::collections::HashMap<String, serde_json::Value>>> {
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
                let parsed: serde_json::Map<String, serde_json::Value> =
                    serde_json::from_str(row_json_str).ok()?;
                Some(
                    parsed
                        .into_iter()
                        .collect::<std::collections::HashMap<String, serde_json::Value>>(),
                )
            })
            .collect();

        msgs.sort_by_key(|m| m.get("created_at").and_then(|v| v.as_i64()).unwrap_or(0));
        Ok(msgs)
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

    /// Upsert a message via reducer.
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

    /// Soft-delete a message by setting deleted=true via reducer.
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
}
