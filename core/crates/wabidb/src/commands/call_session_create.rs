//! `call_session_create` command.
//!
//! Creates a new voice/video call session. Replaces the WDB
//! `call_session_create` reducer.

use crate::domain::CallSession;
use crate::error::{Result, WabiError};
use crate::format::record::RecordKind;
use crate::sequencer::run_command::run_command;
use crate::sequencer::types::{CommandCommit, CommandOutcome, EventToWrite};

/// Stream kind: "other" (see sequencer/mod.rs stream_kind_dir_name).
const STREAM_KIND_OTHER: u8 = 6;

pub async fn create_call_session(
    session_id: String,
    channel_id: String,
    call_type: String,
    host_user_id: u64,
    max_participants: u32,
    transport: String,
    engine: &crate::engine::WabiDbEngine,
    sequencer: &crate::sequencer::run_command::CommitSequencer,
) -> Result<CommandOutcome> {
    if session_id.is_empty() {
        return Err(WabiError::Validation {
            command: "call_session_create".into(),
            reason: "session_id must not be empty".into(),
        });
    }
    if channel_id.is_empty() {
        return Err(WabiError::Validation {
            command: "call_session_create".into(),
            reason: "channel_id must not be empty".into(),
        });
    }
    if call_type.is_empty() {
        return Err(WabiError::Validation {
            command: "call_session_create".into(),
            reason: "call_type must not be empty".into(),
        });
    }

    let session = CallSession::new(
        session_id.clone(),
        channel_id,
        call_type,
        host_user_id,
        max_participants,
        transport,
    );

    let payload = serde_json::to_vec(&session).map_err(|e| WabiError::Validation {
        command: "call_session_create".into(),
        reason: format!("serialize failed: {e}"),
    })?;

    // Register the stream encryption key so the write doesn't fail with
    // `UnknownStreamKey` (the adapter's `run()` normally does this; call
    // commands bypass it).
    engine
        .get_or_create_stream_key(&format!("call_session:{}", session_id))
        .await?;

    let (tx, _rx) = tokio::sync::oneshot::channel();
    let cmd = CommandCommit {
        caller_user_id: host_user_id,
        caller_device_id: format!("dev_{}", host_user_id),
        command_name: "call_session_create".into(),
        idempotency_key: None,
        events: vec![EventToWrite {
            stream_id: format!("call_session:{}", session_id),
            event_type: "call_session_created".into(),
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
        let result = create_call_session(
            "".into(),
            "ch_1".into(),
            "audio-call".into(),
            1,
            10,
            "webrtc".into(),
            &engine,
            sequencer,
        )
        .await;
        assert!(matches!(result, Err(WabiError::Validation { .. })));
    }

    #[tokio::test]
    async fn empty_channel_id_rejected() {
        let engine = setup_engine().await;
        let sequencer = engine.sequencer().unwrap();
        let result = create_call_session(
            "s_1".into(),
            "".into(),
            "audio-call".into(),
            1,
            10,
            "webrtc".into(),
            &engine,
            sequencer,
        )
        .await;
        assert!(matches!(result, Err(WabiError::Validation { .. })));
    }

    #[tokio::test]
    async fn happy_path_creates_session() {
        let engine = setup_engine().await;
        let sequencer = engine.sequencer().unwrap();
        let result = create_call_session(
            "s_1".into(),
            "ch_1".into(),
            "audio-call".into(),
            1,
            10,
            "webrtc".into(),
            &engine,
            sequencer,
        )
        .await;
        assert!(result.is_ok());
    }
}
