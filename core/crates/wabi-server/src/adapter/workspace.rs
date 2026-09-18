//! Private artifact writes: ordered CAS and durable receipt, never chat fan-out.
use super::*;
use crate::error::{AppError, Result as ApiResult};
use wabidb::projections::workspace::{self, WorkspaceDelta, WorkspaceRecord};
static WRITES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

impl WdbAdapter {
    pub fn workspace_get(&self, key: &str) -> ApiResult<Option<WorkspaceRecord>> {
        self.engine.projection_state().get(workspace::INDEX, key.as_bytes())
            .map(|b| workspace::decode(&b)).transpose().map_err(AppError::from)
    }

    pub fn workspace_list(&self, prefix: &str) -> ApiResult<Vec<WorkspaceRecord>> {
        let mut rows = Vec::new();
        let mut error = None;
        self.engine.projection_state().prefix_scan(workspace::INDEX, prefix.as_bytes(), |_, bytes| {
            match workspace::decode(bytes) { Ok(row) => rows.push(row), Err(err) => error = Some(err) }
        });
        if let Some(error) = error { return Err(error.into()); }
        Ok(rows)
    }

    async fn commit_workspace_event(&self, actor: u64, key: &str, event_type: &str, plaintext: Vec<u8>) -> ApiResult<()> {
        let stream_id = format!("workspace:{key}");
        self.engine.get_or_create_stream_key(&stream_id).await?;
        self.engine.run_command(CommandCommit {
            caller_user_id: actor, caller_device_id: "primary".into(), command_name: event_type.into(),
            idempotency_key: None, essential: true,
            events: vec![EventToWrite { stream_id, event_type: event_type.into(), stream_kind: 6, record_kind: RecordKind::Event, plaintext }],
            response_tx: tokio::sync::oneshot::channel().0,
        }).await?;
        Ok(())
    }

    // The sequencer receipt includes projection completion. Verify the actual read
    // model before acknowledging a write; a missing handler must not look saved.
    fn workspace_receipt(&self, expected: WorkspaceRecord) -> ApiResult<WorkspaceRecord> {
        let actual=self.workspace_get(&expected.key)?;
        if actual.as_ref()!=Some(&expected) {
            return Err(AppError::Internal("Workspace commit was not applied to its read model; retain the pending local changes".into()));
        }
        Ok(expected)
    }

    pub async fn workspace_put(&self, actor: u64, key: &str, expected: u64, owner: u64, value: serde_json::Value) -> ApiResult<WorkspaceRecord> {
        let _guard = WRITES.lock().await;
        let before = self.workspace_get(key)?;
        if before.as_ref().map_or(0, |r| r.revision) != expected || before.as_ref().is_some_and(|r| r.owner_user_id != owner) {
            return Err(AppError::Conflict("Workspace changed; reload without discarding the local draft".into()));
        }
        let row = WorkspaceRecord { schema: 1, key: key.into(), revision: expected.checked_add(1).ok_or_else(|| AppError::Conflict("Revision exhausted".into()))?, owner_user_id: owner, value };
        let bytes = serde_json::to_vec(&row).map_err(|e| AppError::Internal(e.to_string()))?;
        workspace::decode(&bytes).map_err(|_| AppError::BadRequest("Workspace exceeds supported storage limits".into()))?;
        self.commit_workspace_event(actor, key, workspace::EVENT, bytes).await?;
        self.workspace_receipt(row)
    }

    pub async fn workspace_append(&self, actor: u64, delta: WorkspaceDelta) -> ApiResult<WorkspaceRecord> {
        let _guard = WRITES.lock().await;
        let before = self.workspace_get(&delta.key)?.ok_or_else(|| AppError::NotFound("Workspace not found".into()))?;
        if before.revision != delta.expected_revision { return Err(AppError::Conflict("Workspace changed".into())); }
        let row = workspace::apply_delta(before, &delta).map_err(|_| AppError::BadRequest("Workspace update exceeds supported limits".into()))?;
        let bytes = serde_json::to_vec(&delta).map_err(|e| AppError::Internal(e.to_string()))?;
        self.commit_workspace_event(actor, &delta.key, workspace::DELTA_EVENT, bytes).await?;
        self.workspace_receipt(row)
    }
}

#[cfg(test)] mod tests {
    use super::*;
    #[tokio::test] async fn workspace_cas_preserves_committed_content() {
        let directory = tempfile::tempdir().unwrap();
        let store = WdbAdapter::open(directory.path()).await.unwrap();
        let uid = store.create_user("workspace-test", None, "registered").await.unwrap();
        let value = serde_json::json!({"updates":[],"title":"Original","sequence":1});
        let first = store.workspace_put(uid,"artifact:test",0,uid,value.clone()).await.unwrap();
        assert!(store.workspace_put(uid,"artifact:test",0,uid,value.clone()).await.is_err());
        assert!(store.workspace_put(uid,"artifact:test",1,uid+1,value).await.is_err());
        assert_eq!(store.workspace_get("artifact:test").unwrap().unwrap(),first);
        assert_eq!(store.workspace_list("artifact:").unwrap().len(),1);
        let d = WorkspaceDelta{key:first.key,expected_revision:1,update:"abc".into(),title:"Updated".into(),sequence:2,updated_at:3};
        let accepted=store.workspace_append(uid,d.clone()).await.unwrap();
        assert_eq!(store.workspace_get("artifact:test").unwrap().unwrap(),accepted);
        assert_eq!(accepted.value["updates"][0],"abc");
        assert!(store.workspace_append(uid,d).await.is_err());
        assert_eq!(store.workspace_get("artifact:test").unwrap().unwrap(),accepted);
        assert!(store.is_healthy());
    }
}
