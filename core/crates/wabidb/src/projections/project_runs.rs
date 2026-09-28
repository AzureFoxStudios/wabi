//! Versioned Project assistant conversations and bounded worker checkpoints.
use crate::{
    engine::locks::ProjectionState,
    error::{Result, WabiError},
    projections::handler::{DurableEvent, Projection},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
pub const EVENT: &str = "project_run_updated";
pub const INDEX: &str = "project_runs";
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStep {
    pub operation_id: String,
    pub tool: String,
    pub arguments: Value,
    pub result: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRun {
    pub schema_version: u8,
    pub run_id: String,
    pub channel_id: String,
    pub created_by_user_id: u64,
    pub bot_user_id: u64,
    pub mode: String,
    pub prompt: String,
    pub reply: String,
    pub status: String,
    pub revision: u64,
    pub attempt: u64,
    pub lease_until_micros: i64,
    pub created_at_micros: i64,
    pub updated_at_micros: i64,
    pub provider: String,
    pub model: String,
    pub checkpoint: String,
    pub pending: Option<RunStep>,
    pub steps: Vec<RunStep>,
}
pub fn encode(run: &ProjectRun) -> Vec<u8> {
    serde_json::to_vec(run).expect("run serialization")
}
pub fn decode(bytes: &[u8]) -> Result<ProjectRun> {
    let run: ProjectRun = serde_json::from_slice(bytes).map_err(|e| WabiError::Corrupt {
        location: INDEX.into(),
        detail: e.to_string(),
    })?;
    if run.schema_version != 1 {
        return Err(WabiError::Corrupt {
            location: INDEX.into(),
            detail: "unknown run version".into(),
        });
    }
    Ok(run)
}
fn prefix(channel: &str) -> Vec<u8> {
    let mut k = (channel.len() as u64).to_le_bytes().to_vec();
    k.extend(channel.as_bytes());
    k
}
fn key(channel: &str, id: &str) -> Vec<u8> {
    let mut k = prefix(channel);
    k.extend(id.as_bytes());
    k
}
pub struct ProjectRunProjection;
impl ProjectRunProjection {
    pub fn get(state: &ProjectionState, channel: &str, id: &str) -> Result<Option<ProjectRun>> {
        state
            .get(INDEX, &key(channel, id))
            .map(|b| decode(&b))
            .transpose()
    }
    pub fn list(state: &ProjectionState, channel: &str) -> Result<Vec<ProjectRun>> {
        let mut values = vec![];
        let mut error = None;
        state.prefix_scan(INDEX, &prefix(channel), |_, bytes| match decode(bytes) {
            Ok(v) => values.push(v),
            Err(e) => error = Some(e),
        });
        if let Some(e) = error {
            return Err(e);
        }
        values.sort_by_key(|r| r.created_at_micros);
        Ok(values)
    }
}
impl Projection for ProjectRunProjection {
    fn event_type(&self) -> &str {
        EVENT
    }
    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let run = decode(&event.payload)?;
        state.insert(
            INDEX,
            key(&run.channel_id, &run.run_id),
            encode(&run),
            event.commit_seq,
        );
        Ok(())
    }
}
