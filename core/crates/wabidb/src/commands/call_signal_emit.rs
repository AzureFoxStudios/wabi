//! `call_signal_emit` command.
//!
//! Emits a signaling message within a call session. Replaces the WDB
//! `call_signal_emit` reducer.

use crate::domain::CallSignal;
use crate::error::{Result, WabiError};
use crate::format::record::RecordKind;
use crate::sequencer::run_command::run_command;
use crate::sequencer::types::{CommandCommit, CommandOutcome, EventToWrite};

const STREAM_KIND_OTHER: u8 = 6;

pub async fn emit_call_signal(
    session_id: String,
    from_user_id: u64,
    signal_type: String,
    target_user_id: Option<u64>,
    payload: String,
    signal_id: u64,
    engine: &crate::engine::WabiDbEngine,
    sequencer: &crate::sequencer::run_command::CommitSequencer,
) -> Result<CommandOutcome> {
    if session_id.is_empty() {
        return Err(WabiError::Validation {
            command: "call_signal_emit".into(),
            reason: "session_id must not be empty".into(),
        });
    }
    if signal_type.is_empty() {
        return Err(WabiError::Validation {
            command: "call_signal_emit".into(),
            reason: "signal_type must not be empty".into(),
        });
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0);

    let signal = CallSignal {
        signal_id,
        session_id: session_id.clone(),
        from_user_id,
        signal_type,
        target_user_id,
        payload,
        created_at_micros: now,
    };

    let event_payload = serde_json::to_vec(&signal).map_err(|e| WabiError::Validation {
        command: "call_signal_emit".into(),
        reason: format!("serialize failed: {e}"),
    })?;

    engine
        .get_or_create_stream_key(&format!("call_signal:{}", session_id))
        .await?;

    let (tx, _rx) = tokio::sync::oneshot::channel();
    let cmd = CommandCommit {
        caller_user_id: from_user_id,
        caller_device_id: format!("dev_{}", from_user_id),
        command_name: "call_signal_emit".into(),
        idempotency_key: None,
        events: vec![EventToWrite {
            stream_id: format!("call_signal:{}", session_id),
            event_type: "call_signal_emitted".into(),
            stream_kind: STREAM_KIND_OTHER,
            record_kind: RecordKind::Event,
            plaintext: event_payload,
        }],
        essential: false,
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
        let result = emit_call_signal(
            "".into(),
            1,
            "offer".into(),
            None,
            "{}".into(),
            1,
            &engine,
            sequencer,
        )
        .await;
        assert!(matches!(result, Err(WabiError::Validation { .. })));
    }

    #[tokio::test]
    async fn empty_signal_type_rejected() {
        let engine = setup_engine().await;
        let sequencer = engine.sequencer().unwrap();
        let result = emit_call_signal(
            "s_1".into(),
            1,
            "".into(),
            None,
            "{}".into(),
            1,
            &engine,
            sequencer,
        )
        .await;
        assert!(matches!(result, Err(WabiError::Validation { .. })));
    }

    #[tokio::test]
    async fn happy_path_emits_signal() {
        let engine = setup_engine().await;
        let sequencer = engine.sequencer().unwrap();
        let result = emit_call_signal(
            "s_1".into(),
            1,
            "offer".into(),
            None,
            "{}".into(),
            1,
            &engine,
            sequencer,
        )
        .await;
        assert!(result.is_ok());
    }
}
