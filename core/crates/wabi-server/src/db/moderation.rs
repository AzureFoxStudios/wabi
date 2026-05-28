use anyhow::Result;
use serde_json::json;

use super::StdbClient;

impl StdbClient {
    /// Check if a user is banned
    pub async fn is_user_banned(&self, user_id: i64) -> Result<bool> {
        let q = format!(
            "SELECT active FROM state_ban WHERE user_id = {} LIMIT 1",
            user_id
        );
        let resp = self.sql_query(&q).await?;
        Ok(resp
            .decode_rows()
            .into_iter()
            .next()
            .and_then(|row| row.get("active").and_then(|v| v.as_bool()))
            .unwrap_or(false))
    }

    /// Ban a user
    pub async fn ban_user(&self, user_id: i64, banned_by: i64, reason: &str) -> Result<()> {
        self.ingest_event(
            "ban",
            "ban",
            &json!({
                "row": { "user_id": user_id, "banned_by": banned_by, "reason": reason }
            }),
        )
        .await
    }

    /// Unban a user
    pub async fn unban_user(&self, user_id: i64) -> Result<()> {
        self.ingest_event(
            "ban",
            "unban",
            &json!({
                "row": { "user_id": user_id }
            }),
        )
        .await
    }

    /// Check if a user is muted in a channel (or server-wide if channel_id is empty)
    pub async fn is_user_muted(&self, user_id: i64, channel_id: Option<&str>) -> Result<bool> {
        let ch_id = channel_id.unwrap_or("*");
        let q = format!("SELECT active FROM state_mute WHERE user_id = {} AND (channel_id = '{}' OR channel_id = '*') LIMIT 1", user_id, ch_id);
        let resp = self.sql_query(&q).await?;
        Ok(resp
            .decode_rows()
            .into_iter()
            .next()
            .and_then(|row| row.get("active").and_then(|v| v.as_bool()))
            .unwrap_or(false))
    }

    /// Mute a user
    pub async fn mute_user(
        &self,
        user_id: i64,
        channel_id: Option<&str>,
        muted_by: i64,
    ) -> Result<()> {
        let ch_id = channel_id.unwrap_or("");
        self.ingest_event(
            "mute",
            "mute",
            &json!({
                "row": { "user_id": user_id, "channel_id": ch_id, "muted_by": muted_by }
            }),
        )
        .await
    }

    /// Unmute a user
    pub async fn unmute_user(&self, user_id: i64, channel_id: Option<&str>) -> Result<()> {
        let ch_id = channel_id.unwrap_or("");
        self.ingest_event(
            "mute",
            "unmute",
            &json!({
                "row": { "user_id": user_id, "channel_id": ch_id }
            }),
        )
        .await
    }

    /// Check if a user is deafened in a channel (or server-wide if channel_id is empty)
    pub async fn is_user_deafened(&self, user_id: i64, channel_id: Option<&str>) -> Result<bool> {
        let ch_id = channel_id.unwrap_or("*");
        let q = format!("SELECT active FROM state_deafen WHERE user_id = {} AND (channel_id = '{}' OR channel_id = '*') LIMIT 1", user_id, ch_id);
        let resp = self.sql_query(&q).await?;
        Ok(resp
            .decode_rows()
            .into_iter()
            .next()
            .and_then(|row| row.get("active").and_then(|v| v.as_bool()))
            .unwrap_or(false))
    }

    /// Deafen a user
    pub async fn deafen_user(
        &self,
        user_id: i64,
        channel_id: Option<&str>,
        deafened_by: i64,
    ) -> Result<()> {
        let ch_id = channel_id.unwrap_or("");
        self.ingest_event(
            "deafen",
            "deafen",
            &json!({
                "row": { "user_id": user_id, "channel_id": ch_id, "deafened_by": deafened_by }
            }),
        )
        .await
    }

    /// Undeafen a user
    pub async fn undeafen_user(&self, user_id: i64, channel_id: Option<&str>) -> Result<()> {
        let ch_id = channel_id.unwrap_or("");
        self.ingest_event(
            "deafen",
            "undeafen",
            &json!({
                "row": { "user_id": user_id, "channel_id": ch_id, "deafened_by": 0 }
            }),
        )
        .await
    }
}
