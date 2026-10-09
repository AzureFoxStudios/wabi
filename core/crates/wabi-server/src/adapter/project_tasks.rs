use serde::{Deserialize, Serialize};
use wabidb::error::WabiError;
use wabidb::projections::project_tasks::{
    encode_record, ChecklistItem, ProjectTaskProjection, ProjectTaskRecord, TaskDecision,
};

use super::{now_micros, WdbAdapter};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTaskFields {
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub status: String,
    pub priority: String,
    #[serde(default)]
    pub due_date_millis: Option<i64>,
    #[serde(default)]
    pub assignee_user_id: Option<u64>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub checklist: Option<Vec<ChecklistItem>>,
    #[serde(default)]
    pub related_task_ids: Option<Vec<String>>,
    #[serde(default)]
    pub human_estimate_minutes: EstimateChange,
    #[serde(default)]
    pub blocked_reason: FieldChange<String>,
    #[serde(default)]
    pub decision: FieldChange<TaskDecision>,
}

/// Missing keeps the stored value; an explicit null clears it; a value sets it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub enum FieldChange<T> {
    #[default]
    Keep,
    Set(Option<T>),
}
impl<'de, T: Deserialize<'de>> Deserialize<'de> for FieldChange<T> {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(Self::Set(Option::<T>::deserialize(d)?))
    }
}

/// Missing keeps the human estimate; explicit null clears it. Bot APIs reject either setter.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub enum EstimateChange {
    #[default]
    Keep,
    Set(Option<u32>),
}
impl<'de> Deserialize<'de> for EstimateChange {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(Self::Set(Option::<u32>::deserialize(d)?))
    }
}

#[derive(Debug)]
pub enum ProjectTaskWriteError {
    Storage(WabiError),
    NotFound,
    Conflict,
}

impl From<WabiError> for ProjectTaskWriteError {
    fn from(error: WabiError) -> Self {
        Self::Storage(error)
    }
}

impl WdbAdapter {
    pub fn project_task_history(
        &self,
        channel_id: &str,
    ) -> wabidb::error::Result<Vec<ProjectTaskRecord>> {
        ProjectTaskProjection::history(&self.engine.projection_state(), channel_id)
    }

    pub fn get_project_task(
        &self,
        channel_id: &str,
        task_id: &str,
    ) -> wabidb::error::Result<Option<ProjectTaskRecord>> {
        ProjectTaskProjection::get_task(&self.engine.projection_state(), channel_id, task_id)
    }

    pub fn list_project_tasks(
        &self,
        channel_id: &str,
    ) -> wabidb::error::Result<Vec<ProjectTaskRecord>> {
        ProjectTaskProjection::list_tasks(&self.engine.projection_state(), channel_id)
    }

    pub async fn create_project_task(
        &self,
        channel_id: &str,
        task_id: &str,
        fields: ProjectTaskFields,
        actor_user_id: u64,
    ) -> Result<ProjectTaskRecord, ProjectTaskWriteError> {
        let _guard = self.project_task_write.lock().await;
        if let Some(existing) = self.get_project_task(channel_id, task_id)? {
            if existing.created_by_user_id == actor_user_id
                && existing.revision == 1
                && existing.title == fields.title
                && existing.description == fields.description
                && existing.status == fields.status
                && existing.priority == fields.priority
                && existing.due_date_millis == fields.due_date_millis
                && existing.assignee_user_id == fields.assignee_user_id
                && existing.notes == fields.notes.clone().unwrap_or_default()
                && existing.checklist == fields.checklist.clone().unwrap_or_default()
                && existing.related_task_ids == fields.related_task_ids.clone().unwrap_or_default()
                && existing.human_estimate_minutes
                    == match fields.human_estimate_minutes {
                        EstimateChange::Keep => None,
                        EstimateChange::Set(v) => v,
                    }
                && existing.blocked_reason
                    == match fields.blocked_reason.clone() {
                        FieldChange::Keep => None,
                        FieldChange::Set(v) => v,
                    }
                && existing.decision
                    == match fields.decision.clone() {
                        FieldChange::Keep => None,
                        FieldChange::Set(v) => v,
                    }
            {
                return Ok(existing);
            }
            return Err(ProjectTaskWriteError::Conflict);
        }
        let now = now_micros();
        let record = ProjectTaskRecord {
            task_id: task_id.to_owned(),
            channel_id: channel_id.to_owned(),
            title: fields.title,
            description: fields.description,
            status: fields.status.clone(),
            priority: fields.priority,
            due_date_millis: fields.due_date_millis,
            assignee_user_id: fields.assignee_user_id,
            created_by_user_id: actor_user_id,
            updated_by_user_id: actor_user_id,
            created_at_micros: now,
            updated_at_micros: now,
            revision: 1,
            is_archived: fields.status == "archived",
            notes: fields.notes.unwrap_or_default(),
            checklist: fields.checklist.unwrap_or_default(),
            related_task_ids: fields.related_task_ids.unwrap_or_default(),
            human_estimate_minutes: match fields.human_estimate_minutes {
                EstimateChange::Keep => None,
                EstimateChange::Set(v) => v,
            },
            blocked_reason: match fields.blocked_reason {
                FieldChange::Keep => None,
                FieldChange::Set(v) => v,
            },
            decision: match fields.decision {
                FieldChange::Keep => None,
                FieldChange::Set(v) => v,
            },
        };
        self.run(
            actor_user_id,
            "create_project_task",
            channel_id.to_owned(),
            "project_task_created",
            6,
            encode_record(&record),
            true,
            None,
        )
        .await?;
        Ok(record)
    }

    pub async fn update_project_task(
        &self,
        channel_id: &str,
        task_id: &str,
        expected_revision: u64,
        fields: ProjectTaskFields,
        actor_user_id: u64,
    ) -> Result<ProjectTaskRecord, ProjectTaskWriteError> {
        let _guard = self.project_task_write.lock().await;
        let mut record = self
            .get_project_task(channel_id, task_id)?
            .ok_or(ProjectTaskWriteError::NotFound)?;
        if record.revision != expected_revision {
            return Err(ProjectTaskWriteError::Conflict);
        }
        record.title = fields.title;
        record.description = fields.description;
        record.status = fields.status;
        record.priority = fields.priority;
        record.due_date_millis = fields.due_date_millis;
        record.assignee_user_id = fields.assignee_user_id;
        if let Some(notes) = fields.notes {
            record.notes = notes;
        }
        if let Some(items) = fields.checklist {
            record.checklist = items;
        }
        if let Some(ids) = fields.related_task_ids {
            record.related_task_ids = ids;
        }
        if let EstimateChange::Set(value) = fields.human_estimate_minutes {
            record.human_estimate_minutes = value;
        }
        if let FieldChange::Set(value) = fields.blocked_reason {
            record.blocked_reason = value;
        }
        if let FieldChange::Set(value) = fields.decision {
            record.decision = value;
        }
        record.is_archived = record.status == "archived";
        record.updated_by_user_id = actor_user_id;
        record.updated_at_micros = now_micros();
        record.revision += 1;
        self.run(
            actor_user_id,
            "update_project_task",
            channel_id.to_owned(),
            "project_task_updated",
            6,
            encode_record(&record),
            true,
            None,
        )
        .await?;
        Ok(record)
    }
}
