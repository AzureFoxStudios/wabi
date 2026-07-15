use crate::crypto::bootstrap::BootstrapSource;
use crate::engine::{WabiDbConfig, WabiDbEngine};
use crate::sequencer::types::{CommandCommit, EventToWrite};
use crate::format::record::RecordKind;
use crate::error::WabiError;

async fn setup_engine() -> (WabiDbEngine, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let config = WabiDbConfig {
        data_dir: dir.path().to_path_buf(),
        bootstrap_source: BootstrapSource::Provided([0u8; 32]),
        bootstrap_salt: None,
        allow_init: true,
        replication_config: None,
        sync_transport: None,
        };
    let engine = WabiDbEngine::open(config).await.unwrap();
    (engine, dir)
}

#[tokio::test]
async fn send_message_flow() {
    let (engine, _dir) = setup_engine().await;

    let channel_id = "ch_test_01";
    let user_id = 42u64;
    let content = "Hello from the integration test!";

    let event = EventToWrite {
        stream_id: channel_id.to_string(),
        event_type: "message_created".into(),
        stream_kind: 1,
        record_kind: RecordKind::Event,
        plaintext: content.as_bytes().to_vec(),
    };

    let (tx, _rx) = tokio::sync::oneshot::channel();
    let cmd = CommandCommit {
        caller_user_id: user_id,
        caller_device_id: "dev_test".into(),
        command_name: "send_message".into(),
        idempotency_key: None,
        events: vec![event],
        essential: true,
        response_tx: tx,
    };

    let result = engine.run_command(cmd).await;
    // UnknownStreamKey is expected: no stream key registered in the engine's StreamKeyRegistry.
    let err = result.expect_err("expected UnknownStreamKey error");
    assert!(
        matches!(&err, WabiError::UnknownStreamKey { .. }),
        "expected UnknownStreamKey, got: {err:?}"
    );
}

#[tokio::test]
async fn non_member_cannot_send() {
    let (engine, _dir) = setup_engine().await;

    let event = EventToWrite {
        stream_id: "ch_restricted".to_string(),
        event_type: "message_created".into(),
        stream_kind: 1,
        record_kind: RecordKind::Event,
        plaintext: b"unauthorized".to_vec(),
    };

    let (tx, _rx) = tokio::sync::oneshot::channel();
    let cmd = CommandCommit {
        caller_user_id: 999,
        caller_device_id: "dev_intruder".into(),
        command_name: "send_message".into(),
        idempotency_key: None,
        events: vec![event],
        essential: true,
        response_tx: tx,
    };

    let result = engine.run_command(cmd).await;
    // UnknownStreamKey is expected: no stream key registered.
    let err = result.expect_err("expected UnknownStreamKey error");
    assert!(
        matches!(&err, WabiError::UnknownStreamKey { .. }),
        "expected UnknownStreamKey, got: {err:?}"
    );
}

#[tokio::test]
async fn two_users_send_and_receive() {
    let (engine, _dir) = setup_engine().await;
    let channel_id = "ch_shared";

    let events = vec![
        (1u64, "dev_a", "Alice says hi"),
        (2u64, "dev_b", "Bob says hi"),
    ];

    for (user_id, device_id, content) in &events {
        let event = EventToWrite {
            stream_id: channel_id.to_string(),
            event_type: "message_created".into(),
            stream_kind: 1,
            record_kind: RecordKind::Event,
            plaintext: content.as_bytes().to_vec(),
        };

        let (tx, _rx) = tokio::sync::oneshot::channel();
        let cmd = CommandCommit {
            caller_user_id: *user_id,
            caller_device_id: device_id.to_string(),
            command_name: "send_message".into(),
            idempotency_key: None,
            events: vec![event],
            essential: true,
            response_tx: tx,
        };

        let result = engine.run_command(cmd).await;
        // UnknownStreamKey is expected: no stream key registered.
        let err = result.expect_err("expected UnknownStreamKey error");
        assert!(
            matches!(&err, WabiError::UnknownStreamKey { .. }),
            "user {user_id} expected UnknownStreamKey, got: {err:?}"
        );
    }
}


#[tokio::test]
async fn dispatch_table_includes_new_projection_handlers() {
    // Verify Task 1 fix: the 4 new projection handlers (users, emotes,
    // webhooks, layouts) are wired into the dispatch table at engine
    // open time. Without this fix, events with event_type=...registere/...
    // routed to a generic "events" index, missing the typed projection.
    let (engine, _dir) = setup_engine().await;
    let table = engine.dispatch_table();

    // The original 5 handlers (messages, reactions, channel_members,
    // dm_messages, dm_message_recipients) are still there.
    assert!(table.get("message_created").is_some(), "MessagesProjection missing");
    assert!(table.get("reaction_added").is_some(), "ReactionsProjection missing");
    assert!(table.get("channel_member_added").is_some(), "ChannelMembersProjection missing");
    assert!(table.get("dm_message_created").is_some(), "DmMessagesProjection missing");
    assert!(table.get("dm_message_recipient_added").is_some(), "DmMessageRecipientsProjection missing");

    // The 4 new handlers from Task 1 are now registered.
    assert!(table.get("user_registered").is_some(), "UsersProjection not wired in");
    assert!(table.get("emote_upserted").is_some(), "EmotesProjection not wired in");
    assert!(table.get("webhook_upserted").is_some(), "WebhooksProjection not wired in");
    assert!(table.get("user_layout_upserted").is_some(), "LayoutsProjection not wired in");
}

#[tokio::test]
async fn projection_state_is_empty_for_fresh_engine() {
    // v1: the engine's projection state is in-memory and starts empty.
    // A fresh engine has no users, channels, or messages indexed.
    // After engine.open() + no commands, projection_state should be empty.
    let (engine, _dir) = setup_engine().await;
    let state = engine.projection_state();

    let mut count = 0;
    state.for_each("users", |_, _| count += 1);
    assert_eq!(count, 0, "fresh engine should have 0 users in projection");

    count = 0;
    state.for_each("channels", |_, _| count += 1);
    assert_eq!(count, 0, "fresh engine should have 0 channels in projection");

    count = 0;
    state.for_each("messages", |_, _| count += 1);
    assert_eq!(count, 0, "fresh engine should have 0 messages in projection");
}
