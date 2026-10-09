//! Durable, channel-scoped Project Kanban cards.
use crate::engine::locks::ProjectionState;
use crate::error::{Result, WabiError};
use crate::projections::handler::{DurableEvent, Projection};
use serde::{Deserialize, Serialize};

pub const INDEX_NAME: &str = "project_tasks";

// A new postcard record type. Future field changes require a versioned decoder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTaskRecord {
    pub task_id: String,
    pub channel_id: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub priority: String,
    pub due_date_millis: Option<i64>,
    pub assignee_user_id: Option<u64>,
    pub created_by_user_id: u64,
    pub updated_by_user_id: u64,
    pub created_at_micros: i64,
    pub updated_at_micros: i64,
    pub revision: u64,
    pub is_archived: bool,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub checklist: Vec<ChecklistItem>,
    #[serde(default)]
    pub related_task_ids: Vec<String>,
    #[serde(default)]
    pub human_estimate_minutes: Option<u32>,
    /// Why the card cannot move ("Waiting on live API keys"). Added after V2 shipped: absent in older rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_reason: Option<String>,
    /// A question that needs a person's answer. Added after V2 shipped: absent in older rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<TaskDecision>,
}

/// "Needs your call": the question, what happens if nobody answers, and by when.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDecision {
    pub question: String,
    #[serde(default)]
    pub fallback: String,
    #[serde(default)]
    pub deadline_millis: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistItem {
    pub id: String,
    pub title: String,
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyProjectTaskRecord {
    pub task_id: String,
    pub channel_id: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub priority: String,
    pub due_date_millis: Option<i64>,
    pub assignee_user_id: Option<u64>,
    pub created_by_user_id: u64,
    pub updated_by_user_id: u64,
    pub created_at_micros: i64,
    pub updated_at_micros: i64,
    pub revision: u64,
    pub is_archived: bool,
}

const V2: &[u8] = b"WPT2\0";

pub fn encode_record(record: &ProjectTaskRecord) -> Vec<u8> {
    let mut bytes = V2.to_vec();
    bytes.extend(serde_json::to_vec(record).expect("project task JSON serialization"));
    bytes
}

pub fn decode_record(bytes: &[u8]) -> Result<ProjectTaskRecord> {
    let corrupt = |detail: String| WabiError::Corrupt {
        location: "project task projection".into(),
        detail,
    };
    if let Some(json) = bytes.strip_prefix(V2) {
        return serde_json::from_slice(json).map_err(|error| corrupt(error.to_string()));
    }
    let old: LegacyProjectTaskRecord =
        postcard::from_bytes(bytes).map_err(|error| corrupt(error.to_string()))?;
    Ok(ProjectTaskRecord {
        task_id: old.task_id,
        channel_id: old.channel_id,
        title: old.title,
        description: old.description,
        status: old.status,
        priority: old.priority,
        due_date_millis: old.due_date_millis,
        assignee_user_id: old.assignee_user_id,
        created_by_user_id: old.created_by_user_id,
        updated_by_user_id: old.updated_by_user_id,
        created_at_micros: old.created_at_micros,
        updated_at_micros: old.updated_at_micros,
        revision: old.revision,
        is_archived: old.is_archived,
        notes: String::new(),
        checklist: vec![],
        related_task_ids: vec![],
        human_estimate_minutes: None,
        blocked_reason: None,
        decision: None,
    })
}

fn channel_prefix(channel_id: &str) -> Vec<u8> {
    let mut key = Vec::with_capacity(8 + channel_id.len());
    key.extend_from_slice(&(channel_id.len() as u64).to_le_bytes());
    key.extend_from_slice(channel_id.as_bytes());
    key
}

pub fn encode_key(channel_id: &str, task_id: &str) -> Vec<u8> {
    let mut key = channel_prefix(channel_id);
    key.extend_from_slice(&(task_id.len() as u64).to_le_bytes());
    key.extend_from_slice(task_id.as_bytes());
    key
}

pub struct ProjectTaskProjection;

impl ProjectTaskProjection {
    pub fn get_task(
        state: &ProjectionState,
        channel_id: &str,
        task_id: &str,
    ) -> Result<Option<ProjectTaskRecord>> {
        state
            .get(INDEX_NAME, &encode_key(channel_id, task_id))
            .map(|bytes| decode_record(&bytes))
            .transpose()
    }

    pub fn history(state: &ProjectionState, channel_id: &str) -> Result<Vec<ProjectTaskRecord>> {
        let mut items = Vec::new();
        let mut error = None;
        state.prefix_scan(
            "project_task_history",
            &channel_prefix(channel_id),
            |_key, bytes| match decode_record(bytes) {
                Ok(item) => items.push(item),
                Err(err) => error = Some(err),
            },
        );
        if let Some(err) = error {
            return Err(err);
        }
        items.sort_by_key(|item| item.updated_at_micros);
        Ok(items)
    }

    pub fn list_tasks(state: &ProjectionState, channel_id: &str) -> Result<Vec<ProjectTaskRecord>> {
        let mut tasks = Vec::new();
        let mut error = None;
        state.prefix_scan(
            INDEX_NAME,
            &channel_prefix(channel_id),
            |_key, value| match decode_record(value) {
                Ok(task) => tasks.push(task),
                Err(err) => error = Some(err),
            },
        );
        if let Some(err) = error {
            return Err(err);
        }
        tasks.sort_by(|a, b| {
            a.created_at_micros
                .cmp(&b.created_at_micros)
                .then_with(|| a.task_id.cmp(&b.task_id))
        });
        Ok(tasks)
    }
}

impl Projection for ProjectTaskProjection {
    fn event_type(&self) -> &str {
        "project_task_created"
    }

    fn event_types(&self) -> Vec<&str> {
        vec!["project_task_created", "project_task_updated"]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let record = decode_record(&event.payload)?;
        state.insert(
            INDEX_NAME,
            encode_key(&record.channel_id, &record.task_id),
            encode_record(&record),
            event.commit_seq,
        );
        let mut history_key = encode_key(&record.channel_id, &record.task_id);
        history_key.extend(record.revision.to_be_bytes());
        state.insert(
            "project_task_history",
            history_key,
            encode_record(&record),
            event.commit_seq,
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> ProjectTaskRecord {
        ProjectTaskRecord {
            task_id: "t".into(),
            channel_id: "c".into(),
            title: "Book the coach".into(),
            description: String::new(),
            status: "todo".into(),
            priority: "high".into(),
            due_date_millis: None,
            assignee_user_id: None,
            created_by_user_id: 1,
            updated_by_user_id: 1,
            created_at_micros: 1,
            updated_at_micros: 2,
            revision: 1,
            is_archived: false,
            notes: String::new(),
            checklist: vec![],
            related_task_ids: vec![],
            human_estimate_minutes: None,
            blocked_reason: None,
            decision: None,
        }
    }

    #[test]
    fn rows_written_before_blocked_reason_and_decision_still_decode() {
        // A V2 row exactly as the previous release wrote it: no blockedReason, no decision keys.
        let mut bytes = V2.to_vec();
        bytes.extend(
            serde_json::to_vec(&serde_json::json!({
                "taskId": "t", "channelId": "c", "title": "Old", "description": "", "status": "todo",
                "priority": "low", "dueDateMillis": null, "assigneeUserId": null,
                "createdByUserId": 1, "updatedByUserId": 1, "createdAtMicros": 1, "updatedAtMicros": 2,
                "revision": 3, "isArchived": false, "notes": "", "checklist": [], "relatedTaskIds": [],
                "humanEstimateMinutes": null
            }))
            .unwrap(),
        );
        let row = decode_record(&bytes).unwrap();
        assert_eq!(row.title, "Old");
        assert_eq!(row.blocked_reason, None);
        assert_eq!(row.decision, None);
    }

    #[test]
    fn plain_cards_serialize_without_the_new_keys_so_older_binaries_read_them() {
        let json = String::from_utf8(encode_record(&base())[V2.len()..].to_vec()).unwrap();
        assert!(!json.contains("blockedReason"));
        assert!(!json.contains("decision"));
    }

    #[test]
    fn blocked_reason_and_decision_round_trip() {
        let mut record = base();
        record.blocked_reason = Some("Waiting on live API keys".into());
        record.decision = Some(TaskDecision {
            question: "Switch Stripe to live mode?".into(),
            fallback: "Stay in test mode".into(),
            deadline_millis: Some(1_700_000_000_000),
        });
        let back = decode_record(&encode_record(&record)).unwrap();
        assert_eq!(back, record);
    }
}
