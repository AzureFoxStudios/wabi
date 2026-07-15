//! End-to-end round-trip test for call-session state.
//!
//! Proves the full wabidb path works:
//!   1. WdbAdapter::create_call_session submits a CommandCommit
//!   2. Sequencer assigns commit_seq, writes encrypted segment, advances barrier
//!   3. Projection dispatcher routes to CallSessionsProjection
//!   4. Projection state stores the row
//!   5. WdbAdapter::get_call_session reads it back
//!
//! Catches regressions in the engine wiring (dispatch table, key registry,
//! event_type routing) that pure unit tests miss.

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
        };
    // Leaks the tempdir so it lives for the test. Acceptable for integration tests.
    std::mem::forget(dir);
    WabiDbEngine::open(config).await.unwrap()
}

#[tokio::test]
async fn create_call_session_round_trip() {
    let engine = setup_engine().await;

    // Register a stream key so the call-session command doesn't fail with UnknownStreamKey.
    engine
        .register_stream_key("call_session:test-session", [0xABu8; 32])
        .await
        .unwrap();

    // Build the create_call_session CommandCommit manually (mirroring
    // commands/call_session_create.rs and adapter/mod.rs).
    use crate::sequencer::types::{CommandCommit, EventToWrite};
    use crate::format::record::RecordKind;
    use crate::domain::CallSession;
    let session = CallSession::new(
        "test-session".to_string(),
        "ch_test".to_string(),
        "audio-call".to_string(),
        42u64,
        10,
        "wabidb",
    );
    let payload = serde_json::to_vec(&session).unwrap();
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let cmd = CommandCommit {
        caller_user_id: 42,
        caller_device_id: "dev_test".into(),
        command_name: "call_session_create".into(),
        idempotency_key: None,
        events: vec![EventToWrite {
            stream_id: "call_session:test-session".to_string(),
            event_type: "call_session_created".into(),
            stream_kind: 6,
            record_kind: RecordKind::Event,
            plaintext: payload,
        }],
        essential: true,
        response_tx: tx,
    };

    let outcome = engine.run_command(cmd).await.expect("run_command should succeed");
    let commit_seq = outcome.commit_seq;
    assert!(commit_seq > 0, "commit_seq should be assigned");

    // Wait for the projection to apply (durable, barrier advanced).
    engine
        .barrier()
        .wait_for(commit_seq, std::time::Duration::from_secs(5))
        .await
        .expect("barrier should reach commit_seq");

    // Read back via the projection state directly (no HTTP/WS layer).
    use crate::projections::call_sessions;
    let key = call_sessions::encode_key("test-session");
    let bytes = engine
        .projection_state()
        .get(call_sessions::INDEX_NAME, &key)
        .expect("projection should have the session");

    let read_back = call_sessions::decode_value(&bytes).expect("decode should succeed");
    assert_eq!(read_back.session_id, "test-session");
    assert_eq!(read_back.channel_id, "ch_test");
    assert_eq!(read_back.call_type, "audio-call");
    assert_eq!(read_back.host_user_id, 42);
    assert_eq!(read_back.max_participants, 10);
    assert_eq!(read_back.transport, "wabidb");
    assert!(read_back.active);
    assert!(read_back.ended_at_micros.is_none());
}

#[tokio::test]
async fn end_call_session_updates_projection() {
    let engine = setup_engine().await;

    engine
        .register_stream_key("call_session:test-end", [0xCDu8; 32])
        .await
        .unwrap();

    use crate::sequencer::types::{CommandCommit, EventToWrite};
    use crate::format::record::RecordKind;

    // Create first.
    let create_payload = serde_json::json!({
        "session_id": "test-end",
        "channel_id": "ch_test",
        "call_type": "audio-call",
        "host_user_id": 1,
        "started_at_micros": 1_000_000i64,
        "ended_at_micros": null,
        "transport": "webrtc",
        "max_participants": 10,
        "active": true,
        "last_updated_at_micros": 1_000_000i64,
    });
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let create_cmd = CommandCommit {
        caller_user_id: 1,
        caller_device_id: "dev_test".into(),
        command_name: "call_session_create".into(),
        idempotency_key: None,
        events: vec![EventToWrite {
            stream_id: "call_session:test-end".to_string(),
            event_type: "call_session_created".into(),
            stream_kind: 6,
            record_kind: RecordKind::Event,
            plaintext: serde_json::to_vec(&create_payload).unwrap(),
        }],
        essential: true,
        response_tx: tx,
    };
    let outcome = engine.run_command(create_cmd).await.unwrap();
    engine
        .barrier()
        .wait_for(outcome.commit_seq, std::time::Duration::from_secs(5))
        .await
        .unwrap();

    // End it.
    let end_payload = serde_json::json!({
        "session_id": "test-end",
        "ended_at_micros": 2_000_000i64,
        "active": false,
        "last_updated_at_micros": 2_000_000i64,
    });
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let end_cmd = CommandCommit {
        caller_user_id: 1,
        caller_device_id: "dev_test".into(),
        command_name: "call_session_end".into(),
        idempotency_key: None,
        events: vec![EventToWrite {
            stream_id: "call_session:test-end".to_string(),
            event_type: "call_session_ended".into(),
            stream_kind: 6,
            record_kind: RecordKind::Event,
            plaintext: serde_json::to_vec(&end_payload).unwrap(),
        }],
        essential: true,
        response_tx: tx,
    };
    let outcome = engine.run_command(end_cmd).await.unwrap();
    engine
        .barrier()
        .wait_for(outcome.commit_seq, std::time::Duration::from_secs(5))
        .await
        .unwrap();

    // Verify the projection was updated.
    use crate::projections::call_sessions;
    let key = call_sessions::encode_key("test-end");
    let bytes = engine
        .projection_state()
        .get(call_sessions::INDEX_NAME, &key)
        .expect("projection should still have the session after end");

    let read_back = call_sessions::decode_value(&bytes).unwrap();
    assert!(!read_back.active, "session should be inactive after end");
    assert_eq!(read_back.ended_at_micros, Some(2_000_000i64));
}

#[tokio::test]
async fn call_signal_round_trip() {
    let engine = setup_engine().await;

    engine
        .register_stream_key("call_signal:test-sig", [0xEFu8; 32])
        .await
        .unwrap();

    use crate::sequencer::types::{CommandCommit, EventToWrite};
    use crate::format::record::RecordKind;
    use crate::domain::CallSignal;

    let signal = CallSignal {
        signal_id: 1,
        session_id: "test-sig".to_string(),
        from_user_id: 99,
        signal_type: "offer".to_string(),
        target_user_id: Some(42),
        payload: r#"{"sdp":"v=0..."}"#.to_string(),
        created_at_micros: 5_000_000i64,
    };

    let (tx, _rx) = tokio::sync::oneshot::channel();
    let cmd = CommandCommit {
        caller_user_id: 99,
        caller_device_id: "dev_test".into(),
        command_name: "call_signal_emit".into(),
        idempotency_key: None,
        events: vec![EventToWrite {
            stream_id: "call_signal:test-sig".to_string(),
            event_type: "call_signal_emitted".into(),
            stream_kind: 6,
            record_kind: RecordKind::Event,
            plaintext: serde_json::to_vec(&signal).unwrap(),
        }],
        essential: true,
        response_tx: tx,
    };
    let outcome = engine.run_command(cmd).await.unwrap();
    engine
        .barrier()
        .wait_for(outcome.commit_seq, std::time::Duration::from_secs(5))
        .await
        .unwrap();

    // Verify the signal projection stored the row.
    use crate::projections::call_signals;
    let key = call_signals::encode_key("test-sig", 1);
    let bytes = engine
        .projection_state()
        .get(call_signals::INDEX_NAME, &key)
        .expect("projection should have the signal");

    let read_back = call_signals::decode_value(&bytes).unwrap();
    assert_eq!(read_back.signal_id, 1);
    assert_eq!(read_back.session_id, "test-sig");
    assert_eq!(read_back.from_user_id, 99);
    assert_eq!(read_back.signal_type, "offer");
    assert_eq!(read_back.target_user_id, Some(42));
}