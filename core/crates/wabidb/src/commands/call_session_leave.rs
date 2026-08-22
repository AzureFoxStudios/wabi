//! `call_session_leave` command.
//!
//! Marks a participant as having left a call session. Replaces the WDB
//! `call_session_leave` reducer.

use crate::error::{Result, WabiError};
use crate::format::record::RecordKind;
use crate::sequencer::run_command::run_command;
use crate::sequencer::types::{CommandCommit, CommandOutcome, EventToWrite};

const STREAM_KIND_OTHER: u8 = 6;

pub async fn leave_call_session(
    session_id: String,
    user_id: u64,
    engine: &crate::engine::WabiDbEngine,
    sequencer: &crate::sequencer::run_command::CommitSequencer,
) -> Result<CommandOutcome> {
    if session_id.is_empty() {
        return Err(WabiError::Validation {
            command: "call_session_leave".into(),
            reason: "session_id must not be empty".into(),
        });
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0);

    let participant_key = format!("{}:{}", session_id, user_id);

    engine
        .get_or_create_stream_key(&format!("call_participant:{}", participant_key))
        .await?;

    // Emit an update marker event. The projection is expected to load
    // the existing participant record by key and update left_at_micros
    // and last_updated_at_micros.
    let event_payload = serde_json::json!({
        "session_id": session_id,
        "user_id": user_id,
        "left_at_micros": now,
        "last_updated_at_micros": now,
    });

    let payload = serde_json::to_vec(&event_payload).map_err(|e| WabiError::Validation {
        command: "call_session_leave".into(),
        reason: format!("serialize failed: {e}"),
    })?;

    let (tx, _rx) = tokio::sync::oneshot::channel();
    let cmd = CommandCommit {
        caller_user_id: user_id,
        caller_device_id: format!("dev_{}", user_id),
        command_name: "call_session_leave".into(),
        idempotency_key: None,
        events: vec![EventToWrite {
            stream_id: format!("call_participant:{}", participant_key),
            event_type: "call_participant_left".into(),
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
    use crate::crypto::bootstrap::BootstrapSource;
    use crate::engine::{WabiDbConfig, WabiDbEngine};
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
            test_boot_wallclock_override: None,
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
        let result = leave_call_session("".into(), 1, &engine, sequencer).await;
        assert!(matches!(result, Err(WabiError::Validation { .. })));
    }

    #[tokio::test]
    async fn happy_path_leaves_session() {
        let engine = setup_engine().await;
        let sequencer = engine.sequencer().unwrap();
        let result = leave_call_session("s_1".into(), 1, &engine, sequencer).await;
        assert!(result.is_ok());
    }
}
