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
pub const WORKER_EVENT: &str = "project_worker_updated_v1";
pub const WORKER_INDEX: &str = "project_workers";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryPolicy {
    pub automatic: bool,
    pub backup_worker_ids: Vec<String>,
    pub max_recoveries: u8,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWorker {
    pub schema_version: u8,
    pub worker_id: String,
    pub channel_id: String,
    pub bot_user_id: u64,
    pub name: String,
    pub harness: String,
    pub provider: String,
    pub model: String,
    pub last_seen_micros: i64,
    pub enabled: bool,
}
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
    // Additive fields on the versioned JSON record; older events decode with
    // manual recovery and no registered worker. This is not a postcard change.
    #[serde(default)]
    pub worker_id: Option<String>,
    #[serde(default)]
    pub target_worker_id: Option<String>,
    #[serde(default)]
    pub recovery_policy: Option<RecoveryPolicy>,
    #[serde(default)]
    pub recovery_count: u8,
}
pub fn encode_worker(worker: &ProjectWorker) -> Vec<u8> {
    serde_json::to_vec(worker).expect("worker serialization")
}
pub fn decode_worker(bytes: &[u8]) -> Result<ProjectWorker> {
    let worker: ProjectWorker = serde_json::from_slice(bytes).map_err(|e| WabiError::Corrupt {
        location: WORKER_INDEX.into(),
        detail: e.to_string(),
    })?;
    if worker.schema_version != 1 {
        return Err(WabiError::Corrupt {
            location: WORKER_INDEX.into(),
            detail: "unknown worker version".into(),
        });
    }
    Ok(worker)
}
pub struct ProjectWorkerProjection;
impl ProjectWorkerProjection {
    pub fn get(state: &ProjectionState, channel: &str, id: &str) -> Result<Option<ProjectWorker>> {
        state
            .get(WORKER_INDEX, &key(channel, id))
            .map(|b| decode_worker(&b))
            .transpose()
    }
    pub fn list(state: &ProjectionState, channel: &str) -> Result<Vec<ProjectWorker>> {
        let mut values = vec![];
        let mut error = None;
        state.prefix_scan(
            WORKER_INDEX,
            &prefix(channel),
            |_, bytes| match decode_worker(bytes) {
                Ok(v) => values.push(v),
                Err(e) => error = Some(e),
            },
        );
        if let Some(e) = error {
            return Err(e);
        }
        values.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(values)
    }
}
impl Projection for ProjectWorkerProjection {
    fn event_type(&self) -> &str {
        WORKER_EVENT
    }
    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let worker = decode_worker(&event.payload)?;
        state.insert(
            WORKER_INDEX,
            key(&worker.channel_id, &worker.worker_id),
            encode_worker(&worker),
            event.commit_seq,
        );
        Ok(())
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_json_runs_keep_manual_recovery_and_no_worker_binding() {
        let bytes=serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"runId":"run_a","channelId":"ch_a","createdByUserId":1,"botUserId":2,"mode":"chat","prompt":"Old request","reply":"","status":"queued","revision":1,"attempt":0,"leaseUntilMicros":0,"createdAtMicros":1,"updatedAtMicros":1,"provider":"","model":"","checkpoint":"Waiting","pending":null,"steps":[]})).unwrap();
        let run = decode(&bytes).unwrap();
        assert!(
            run.worker_id.is_none()
                && run.target_worker_id.is_none()
                && run.recovery_policy.is_none()
        );
        assert_eq!(run.recovery_count, 0);
        assert!(decode(&encode(&run)).unwrap().recovery_policy.is_none());
    }
}
