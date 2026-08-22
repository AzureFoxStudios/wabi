//! `call_session_join` command.
//!
//! Joins a user to an existing call session. Replaces the WDB
//! `call_session_join` reducer.

use crate::domain::CallParticipant;
use crate::error::{Result, WabiError};
use crate::format::record::RecordKind;
use crate::sequencer::run_command::run_command;
use crate::sequencer::types::{CommandCommit, CommandOutcome, EventToWrite};

const STREAM_KIND_OTHER: u8 = 6;

pub async fn join_call_session(
    session_id: String,
    user_id: u64,
    stable_user_id: String,
    is_host: bool,
    engine: &crate::engine::WabiDbEngine,
    sequencer: &crate::sequencer::run_command::CommitSequencer,
) -> Result<CommandOutcome> {
    if session_id.is_empty() {
        return Err(WabiError::Validation {
            command: "call_session_join".into(),
            reason: "session_id must not be empty".into(),
        });
    }

    let participant = CallParticipant::new(session_id.clone(), user_id, stable_user_id, is_host);

    engine
        .get_or_create_stream_key(&format!("call_participant:{}", participant.participant_key))
        .await?;

    let payload = serde_json::to_vec(&participant).map_err(|e| WabiError::Validation {
        command: "call_session_join".into(),
        reason: format!("serialize failed: {e}"),
    })?;

    let (tx, _rx) = tokio::sync::oneshot::channel();
    let cmd = CommandCommit {
        caller_user_id: user_id,
        caller_device_id: format!("dev_{}", user_id),
        command_name: "call_session_join".into(),
        idempotency_key: None,
        events: vec![EventToWrite {
            stream_id: format!("call_participant:{}", participant.participant_key),
            event_type: "call_participant_joined".into(),
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
        let result =
            join_call_session("".into(), 1, "stable-1".into(), false, &engine, sequencer).await;
        assert!(matches!(result, Err(WabiError::Validation { .. })));
    }

    #[tokio::test]
    async fn happy_path_joins_session() {
        let engine = setup_engine().await;
        let sequencer = engine.sequencer().unwrap();
        let result = join_call_session(
            "s_1".into(),
            1,
            "stable-1".into(),
            false,
            &engine,
            sequencer,
        )
        .await;
        assert!(result.is_ok());
    }
}
