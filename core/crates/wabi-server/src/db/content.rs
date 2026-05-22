use anyhow::Result;
use serde_json::{json, Value};

use super::StdbClient;

impl StdbClient {
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
}
