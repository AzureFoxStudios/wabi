use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::handler::{DurableEvent, Projection};
use serde::{Deserialize, Serialize};

/// Singleton record recording which user owns the server.
/// Stored under the `server_meta` index with a fixed key, so it never
/// collides with the `users` projection and does not require changing the
/// `UserRecord` postcard schema (which would corrupt existing data).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OwnerRecord {
    pub owner_user_id: u64,
}

pub const OWNER_KEY: &[u8] = b"owner";

pub struct OwnerProjection;

impl Projection for OwnerProjection {
    fn event_type(&self) -> &str {
        "owner_claimed"
    }

    fn event_types(&self) -> Vec<&str> {
        vec!["owner_claimed"]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let rec: OwnerRecord = serde_json::from_slice(&event.payload).map_err(|e| {
            crate::error::WabiError::Corrupt {
                location: "owner projection".into(),
                detail: format!("owner decode failed: {e}"),
            }
        })?;
        let value = serde_json::to_vec(&rec).map_err(|e| crate::error::WabiError::Corrupt {
            location: "owner projection".into(),
            detail: format!("owner encode failed: {e}"),
        })?;
        state.insert("server_meta", OWNER_KEY.to_vec(), value, event.commit_seq);
        Ok(())
    }
}

impl OwnerProjection {
    /// Read the current owner user id from projection state, if any.
    pub fn get_owner(state: &ProjectionState) -> Option<u64> {
        state
            .get("server_meta", OWNER_KEY)
            .and_then(|v| serde_json::from_slice::<OwnerRecord>(&v).ok())
            .map(|r| r.owner_user_id)
    }
}
