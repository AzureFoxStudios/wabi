//! `call_session_end` command.
//!
//! Marks a call session as ended. Replaces the WDB
//! `call_session_end` reducer.

use crate::error::{Result, WabiError};
use crate::format::record::RecordKind;
use crate::sequencer::run_command::run_command;
use crate::sequencer::types::{CommandCommit, CommandOutcome, EventToWrite};

const STREAM_KIND_OTHER: u8 = 6;

pub async fn end_call_session(
    session_id: String,
    actor_user_id: u64,
    engine: &crate::engine::WabiDbEngine,
    sequencer: &crate::sequencer::run_command::CommitSequencer,
) -> Result<CommandOutcome> {
    if session_id.is_empty() {
        return Err(WabiError::Validation {
            command: "call_session_end".into(),
            reason: "session_id must not be empty".into(),
        });
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0);

    engine
        .get_or_create_stream_key(&format!("call_session:{}", session_id))
        .await?;

    let event_payload = serde_json::json!({
        "session_id": session_id,
        "ended_at_micros": now,
        "active": false,
        "last_updated_at_micros": now,
    });

    let payload = serde_json::to_vec(&event_payload).map_err(|e| WabiError::Validation {
        command: "call_session_end".into(),
        reason: format!("serialize failed: {e}"),
    })?;

    let (tx, _rx) = tokio::sync::oneshot::channel();
    let cmd = CommandCommit {
        caller_user_id: actor_user_id,
        caller_device_id: format!("dev_{}", actor_user_id),
        command_name: "call_session_end".into(),
        idempotency_key: None,
        events: vec![EventToWrite {
            stream_id: format!("call_session:{}", session_id),
            event_type: "call_session_ended".into(),
            stream_kind: STREAM_KIND_OTHER,
            record_kind: RecordKind::Event,
            plaintext: payload,
        }],
        essential: true,
        response_tx: tx,
    };

    run_command(cmd, sequencer).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{WabiDbConfig, WabiDbEngine};
    use crate::crypto::bootstrap::BootstrapSource;
    use tempfile::tempdir;

    async fn setup_engine() -> WabiDbEngine {
        let dir = tempdir().unwrap();
        let config = WabiDbConfig {
            data_dir: dir.path().to_path_buf(),
            bootstrap_source: BootstrapSource::Provided([0u8; 32]),
            bootstrap_salt: None,
            allow_init: true,
            replication_config: None,
            sync_transport: None,
        };
        let engine = WabiDbEngine::open(config).await.unwrap();
        // Leak the tempdir so it lives for the test (mirrors replay_test.rs).
        std::mem::forget(dir);
        engine
    }

    #[tokio::test]
    async fn empty_session_id_rejected() {
        let engine = setup_engine().await;
        let sequencer = engine.sequencer().unwrap();
        let result = end_call_session(
            "".into(),
            1,
            &engine,
            sequencer,
        )
        .await;
        assert!(matches!(result, Err(WabiError::Validation { .. })));
    }

    #[tokio::test]
    async fn happy_path_ends_session() {
        let engine = setup_engine().await;
        let sequencer = engine.sequencer().unwrap();
        let result = end_call_session("s_1".into(), 1, &engine, sequencer).await;
        assert!(result.is_ok());
    }
}