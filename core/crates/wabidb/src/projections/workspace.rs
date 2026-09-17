//! Versioned JSON records. These events must never enter the public chat fan-out.
use serde::{Deserialize, Serialize};
use crate::{engine::locks::ProjectionState, error::{Result, WabiError}, projections::handler::{DurableEvent, Projection}};

pub const INDEX: &str = "workspace_records_v1";
pub const EVENT: &str = "workspace_record_replaced_v1";
pub const DELTA_EVENT: &str = "workspace_update_appended_v1";
pub const MAX_BYTES: usize = 24 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRecord {
    pub schema: u8,
    pub key: String,
    pub revision: u64,
    pub owner_user_id: u64,
    pub value: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceDelta {
    pub key: String,
    pub expected_revision: u64,
    pub update: String,
    pub title: String,
    pub sequence: u64,
    pub updated_at: u64,
}

fn invalid() -> WabiError { WabiError::Corrupt { location: INDEX.into(), detail: "Invalid workspace record".into() } }

pub fn decode(bytes: &[u8]) -> Result<WorkspaceRecord> {
    if bytes.len() > MAX_BYTES { return Err(invalid()); }
    let row: WorkspaceRecord = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    if row.schema != 1 || row.owner_user_id == 0 || row.revision == 0 || row.key.len() > 160 ||
        !(row.key.starts_with("artifact:") || row.key.starts_with("session:") || row.key == "settings") || !row.value.is_object() {
        return Err(invalid());
    }
    Ok(row)
}

pub fn apply_delta(mut row: WorkspaceRecord, change: &WorkspaceDelta) -> Result<WorkspaceRecord> {
    if row.key != change.key || row.revision != change.expected_revision || change.title.len() > 800 || change.update.len() > 17 * 1024 * 1024 {
        return Err(invalid());
    }
    let updates = row.value.get_mut("updates").and_then(|v| v.as_array_mut()).ok_or_else(invalid)?;
    if updates.len() >= 32 { return Err(invalid()); }
    updates.push(serde_json::Value::String(change.update.clone()));
    row.value["title"] = change.title.clone().into();
    row.value["sequence"] = change.sequence.into();
    row.value["updatedAt"] = change.updated_at.into();
    row.revision = row.revision.checked_add(1).ok_or_else(invalid)?;
    decode(&serde_json::to_vec(&row).map_err(|_| invalid())?)
}

pub struct WorkspaceProjection;
impl Projection for WorkspaceProjection {
    fn event_type(&self) -> &str { EVENT }
    fn apply(&self, record: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let row = if record.event_type == DELTA_EVENT {
            let change: WorkspaceDelta = serde_json::from_slice(&record.payload).map_err(|_| invalid())?;
            let bytes = state.get(INDEX, change.key.as_bytes()).ok_or_else(invalid)?;
            apply_delta(decode(&bytes)?, &change)?
        } else { decode(&record.payload)? };
        let bytes = serde_json::to_vec(&row).map_err(|_| invalid())?;
        state.insert(INDEX, row.key.as_bytes().to_vec(), bytes, record.commit_seq);
        Ok(())
    }
}

#[cfg(test)] mod tests {
    use super::*;
    fn row() -> WorkspaceRecord { WorkspaceRecord { schema: 1, key: "artifact:test".into(), revision: 1, owner_user_id: 2, value: serde_json::json!({"updates":[],"title":"A","sequence":1}) } }
    #[test] fn version_owner_and_shape_are_validated() {
        let mut r=row(); assert!(decode(&serde_json::to_vec(&r).unwrap()).is_ok());
        r.schema=2; assert!(decode(&serde_json::to_vec(&r).unwrap()).is_err());
        r.schema=1; r.owner_user_id=0; assert!(decode(&serde_json::to_vec(&r).unwrap()).is_err());
    }
    #[test] fn delta_cannot_skip_revision_or_replace_ownership() {
        let mut d=WorkspaceDelta{key:"artifact:test".into(),expected_revision:1,update:"abc".into(),title:"B".into(),sequence:2,updated_at:3};
        let next=apply_delta(row(),&d).unwrap(); assert_eq!(next.revision,2); assert_eq!(next.owner_user_id,2); assert_eq!(next.value["updates"][0],"abc");
        d.expected_revision=0; assert!(apply_delta(row(),&d).is_err());
    }
}
