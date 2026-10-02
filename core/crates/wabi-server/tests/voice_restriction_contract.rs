//! Per-channel moderation must be enforced by real durable commands and replay.
#[path = "fixtures/writer_drain.rs"]
mod writer_drain;

use wabi_server::adapter::WdbAdapter;
use wabidb::{
    engine::{locks::ProjectionState, wabi_store::WabiStore},
    error::WabiError,
    format::record::RecordKind,
    projections::voice_restrictions::{encode_key, DEAFENS, MUTES},
    sequencer::types::{CommandCommit, EventToWrite},
};

#[tokio::test]
async fn actual_moderation_commands_survive_snapshot_and_full_replay() {
    for full_replay in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let store = WdbAdapter::open(dir.path()).await.unwrap();
        let actor = store
            .create_user("moderator", None, "fixture-hash")
            .await
            .unwrap();
        let target = store
            .create_user("target", None, "fixture-hash")
            .await
            .unwrap();
        let other = store
            .create_user("other", None, "fixture-hash")
            .await
            .unwrap();
        let channel = store
            .create_channel("voice", wabidb::domain::ChannelKind::Voice, actor, false)
            .await
            .unwrap();
        assert!(!store.is_user_muted(&channel, target).await.unwrap());
        assert!(!store.is_user_deafened(&channel, target).await.unwrap());

        store
            .mute_user(&channel, actor, target, i64::MAX)
            .await
            .unwrap();
        store.deafen_user(&channel, actor, target).await.unwrap();
        assert!(store.is_user_muted(&channel, target).await.unwrap());
        assert!(store.is_user_deafened(&channel, target).await.unwrap());
        assert!(!store.is_user_muted("unrelated", target).await.unwrap());
        assert!(!store.is_user_muted(&channel, other).await.unwrap());
        assert!(!store.is_user_deafened("unrelated", target).await.unwrap());
        assert!(!store.is_user_deafened(&channel, other).await.unwrap());
        let projected = store
            .engine()
            .projection_state()
            .get(MUTES, &encode_key(&channel, target))
            .unwrap();
        let projected = wabidb::projections::voice_restrictions::decode_mute(&projected).unwrap();
        assert_eq!(projected.muted_by_user_id, actor);
        assert!(projected.set_at_micros > 0);
        // A past timestamp is an expired mute, not an indefinite restriction.
        store.mute_user(&channel, actor, other, 1).await.unwrap();
        assert!(!store.is_user_muted(&channel, other).await.unwrap());
        store.unmute_user(&channel, actor, target).await.unwrap();
        store.undeafen_user(&channel, actor, target).await.unwrap();
        assert!(!store.is_user_muted(&channel, target).await.unwrap());
        assert!(!store.is_user_deafened(&channel, target).await.unwrap());
        store
            .mute_user(&channel, actor, target, i64::MAX)
            .await
            .unwrap();
        store.deafen_user(&channel, actor, target).await.unwrap();
        let watermark = store.engine().projection_state().applied_commit_seq();
        drop(store);
        if full_replay {
            let stopped = writer_drain::wait_for_stopped_engine(dir.path()).await;
            ProjectionState::remove_snapshot(dir.path());
            drop(stopped);
        }
        let store = writer_drain::retry(
            || WdbAdapter::open(dir.path()),
            |error| matches!(error, wabidb::error::WabiError::AlreadyRunning),
        )
        .await
        .unwrap();
        assert_eq!(
            store.engine().projection_state().applied_commit_seq(),
            watermark
        );
        assert!(store.is_user_muted(&channel, target).await.unwrap());
        assert!(store.is_user_deafened(&channel, target).await.unwrap());
        assert!(!store.is_user_muted(&channel, other).await.unwrap());
        store.unmute_user(&channel, actor, target).await.unwrap();
        store.undeafen_user(&channel, actor, target).await.unwrap();
        drop(store);
        if full_replay {
            let stopped = writer_drain::wait_for_stopped_engine(dir.path()).await;
            ProjectionState::remove_snapshot(dir.path());
            drop(stopped);
        }
        let store = writer_drain::retry(
            || WdbAdapter::open(dir.path()),
            |error| matches!(error, wabidb::error::WabiError::AlreadyRunning),
        )
        .await
        .unwrap();
        assert!(!store.is_user_muted(&channel, target).await.unwrap());
        assert!(!store.is_user_deafened(&channel, target).await.unwrap());
        assert!(store
            .engine()
            .projection_state()
            .get(MUTES, &encode_key(&channel, target))
            .is_none());
        assert!(store
            .engine()
            .projection_state()
            .get(DEAFENS, &encode_key(&channel, target))
            .is_none());
    }
}

#[tokio::test]
async fn corrupt_or_mismatched_restriction_records_are_errors() {
    let dir = tempfile::tempdir().unwrap();
    let store = WdbAdapter::open(dir.path()).await.unwrap();
    let state = store.engine().projection_state();
    // Deliberate corruption of a disposable read model, not an implementation
    // substitute for the command/replay tests above.
    for index in [MUTES, DEAFENS] {
        state.insert(
            index,
            encode_key("voice", 9),
            b"CORRUPT-RESTRICTION-FIXTURE".to_vec(),
            0,
        );
    }
    assert!(matches!(
        store.is_user_muted("voice", 9).await,
        Err(WabiError::Corrupt { .. })
    ));
    assert!(matches!(
        store.is_user_deafened("voice", 9).await,
        Err(WabiError::Corrupt { .. })
    ));
    state.insert(
        MUTES,
        encode_key("voice", 9),
        serde_json::to_vec(&wabidb::domain::MuteRecord {
            channel_id: "different-channel".into(),
            user_id: 9,
            muted_by_user_id: 1,
            until_micros: i64::MAX,
            set_at_micros: 1,
        })
        .unwrap(),
        0,
    );
    state.insert(
        DEAFENS,
        encode_key("voice", 9),
        serde_json::to_vec(&wabidb::domain::DeafenRecord {
            channel_id: "voice".into(),
            user_id: 8,
            deafened_by_user_id: 1,
            set_at_micros: 1,
        })
        .unwrap(),
        0,
    );
    assert!(matches!(
        store.is_user_muted("voice", 9).await,
        Err(WabiError::Corrupt { .. })
    ));
    assert!(matches!(
        store.is_user_deafened("voice", 9).await,
        Err(WabiError::Corrupt { .. })
    ));
}

async fn legacy_event(store: &WdbAdapter, event_type: &str, channel: &str, target: u64) -> Vec<u8> {
    let index = if matches!(event_type, "user_muted" | "user_unmuted") {
        MUTES
    } else {
        DEAFENS
    };
    let stream_id = format!("{index}:{channel}:{target}");
    let mut payload = serde_json::json!({"channel_id":channel,"target_user_id":target});
    if event_type == "user_muted" {
        payload["until_micros"] = serde_json::json!(i64::MAX);
    }
    let payload = serde_json::to_vec(&payload).unwrap();
    store
        .engine()
        .get_or_create_stream_key(&stream_id)
        .await
        .unwrap();
    store
        .engine()
        .run_command(CommandCommit {
            room_owner_precondition: None,
            caller_user_id: 9,
            caller_device_id: "fixture".into(),
            command_name: event_type.into(),
            idempotency_key: None,
            events: vec![EventToWrite {
                stream_id,
                event_type: event_type.into(),
                stream_kind: 1,
                record_kind: RecordKind::Event,
                plaintext: payload.clone(),
            }],
            essential: true,
            response_tx: tokio::sync::oneshot::channel().0,
        })
        .await
        .unwrap();
    payload
}

#[tokio::test]
async fn old_ignored_events_are_rebuilt_before_admission_without_changing_other_indices() {
    let dir = tempfile::tempdir().unwrap();
    let store = WdbAdapter::open(dir.path()).await.unwrap();
    let actor = store
        .create_user("preserved-user", None, "fixture-hash")
        .await
        .unwrap();
    store
        .create_group("group-legacy", "membership repair", actor, &[actor, 2])
        .await
        .unwrap();
    let removed_member =
        wabidb::projections::channel_members::ChannelMembersProjection::list_members(
            store.engine().projection_state(),
            "group-legacy",
        )
        .unwrap()
        .into_iter()
        .find(|member| member.user_id == 2)
        .unwrap();
    store
        .remove_channel_member("group-legacy", 2)
        .await
        .unwrap();
    let mut markers = Vec::new();
    // Last fallback marker alone cannot enumerate both restricted pairs.
    legacy_event(&store, "user_muted", "voice-a", 2).await;
    legacy_event(&store, "user_muted", "voice-b", 3).await;
    markers.push((
        "user_muted",
        legacy_event(&store, "user_muted", "voice-c", 4).await,
    ));
    markers.push((
        "user_unmuted",
        legacy_event(&store, "user_unmuted", "voice-c", 4).await,
    ));
    legacy_event(&store, "user_deafened", "voice-a", 2).await;
    legacy_event(&store, "user_deafened", "voice-b", 3).await;
    markers.push((
        "user_deafened",
        legacy_event(&store, "user_deafened", "voice-c", 4).await,
    ));
    markers.push((
        "user_undeafened",
        legacy_event(&store, "user_undeafened", "voice-c", 4).await,
    ));
    let state = store.engine().projection_state();
    let watermark = state.applied_commit_seq();
    // Reproduce the old dispatcher checkpoint with missing restriction rows
    // and its last unhandled payload per event type. Real committed history is
    // untouched; the next engine open must discover every affected pair.
    state.compact_index(MUTES, |_, _| true);
    state.compact_index(DEAFENS, |_, _| true);
    // Both legacy repairs can be active at one checkpoint. Neither may
    // interpret the other domain's historical events or restore a removal.
    state.insert(
        "channel_members",
        wabidb::projections::channel_members::encode_key("group-legacy", 2),
        wabidb::projections::channel_members::encode_record(&removed_member),
        watermark,
    );
    state.insert(
        "events",
        b"channel_member_removed".to_vec(),
        wabidb::projections::channel_members::encode_record(&removed_member),
        watermark,
    );
    for (event_type, payload) in markers {
        state.insert("events", event_type.as_bytes().to_vec(), payload, watermark);
    }
    state.insert(
        "unrelated-fixture",
        b"keep".to_vec(),
        b"PRESERVED".to_vec(),
        watermark,
    );
    drop(store);
    let store = writer_drain::retry(
        || WdbAdapter::open(dir.path()),
        |error| matches!(error, wabidb::error::WabiError::AlreadyRunning),
    )
    .await
    .unwrap();
    assert_eq!(
        store.engine().projection_state().applied_commit_seq(),
        watermark
    );
    assert!(store.get_user(actor).await.unwrap().is_some());
    assert!(!store
        .list_channel_members("group-legacy")
        .await
        .unwrap()
        .iter()
        .any(|member| member.user_id == 2));
    assert_eq!(
        store
            .engine()
            .projection_state()
            .get("unrelated-fixture", b"keep")
            .as_deref(),
        Some(b"PRESERVED".as_slice())
    );
    for (channel, target) in [("voice-a", 2), ("voice-b", 3)] {
        assert!(store.is_user_muted(channel, target).await.unwrap());
        assert!(store.is_user_deafened(channel, target).await.unwrap());
    }
    assert!(!store.is_user_muted("voice-c", 4).await.unwrap());
    assert!(!store.is_user_deafened("voice-c", 4).await.unwrap());
    for event_type in wabidb::projections::voice_restrictions::EVENTS {
        assert!(store
            .engine()
            .projection_state()
            .get("events", event_type.as_bytes())
            .is_none());
    }
    drop(store);
    let store = writer_drain::retry(
        || WdbAdapter::open(dir.path()),
        |error| matches!(error, wabidb::error::WabiError::AlreadyRunning),
    )
    .await
    .unwrap();
    assert!(store.is_user_muted("voice-a", 2).await.unwrap());
    assert!(store.is_user_deafened("voice-b", 3).await.unwrap());
}

#[tokio::test]
async fn legacy_repair_refuses_missing_indexed_history_and_preserves_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let store = WdbAdapter::open(dir.path()).await.unwrap();
    let payload = legacy_event(&store, "user_muted", "voice-a", 2).await;
    let state = store.engine().projection_state();
    state.compact_index(MUTES, |_, _| true);
    state.insert(
        "events",
        b"user_muted".to_vec(),
        payload,
        state.applied_commit_seq(),
    );
    drop(store);
    let stopped = writer_drain::wait_for_stopped_engine(dir.path()).await;
    let snapshot = ProjectionState::snapshot_path(dir.path());
    let before = std::fs::read(&snapshot).unwrap();
    std::fs::remove_dir_all(dir.path().join("streams")).unwrap();
    drop(stopped);
    let reopened = writer_drain::retry(
        || WdbAdapter::open(dir.path()),
        |error| matches!(error, wabidb::error::WabiError::AlreadyRunning),
    )
    .await;
    assert!(matches!(reopened, Err(WabiError::Corrupt { .. })));
    assert_eq!(std::fs::read(snapshot).unwrap(), before);
}
