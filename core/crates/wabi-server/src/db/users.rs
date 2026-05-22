use anyhow::Result;
use serde_json::{json, Value};

use super::StdbClient;

impl StdbClient {
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

        let users = self.get_user(username).await?;
        if let Some(user) = users.first() {
            if let Some(id) = user.get("user_id").and_then(|v| v.as_i64()) {
                return Ok(id);
            }
        }
        Ok(-1)
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
}
