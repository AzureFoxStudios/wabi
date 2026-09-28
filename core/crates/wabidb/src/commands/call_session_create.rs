//! `call_session_create` command.
//!
//! Creates a new voice/video call session. Replaces the WDB
//! `call_session_create` reducer.

use crate::domain::CallSession;
use crate::error::{Result, WabiError};
use crate::format::record::RecordKind;
use crate::projections::{call_sessions, room_placement};
use crate::sequencer::run_command::run_command;
use crate::sequencer::types::{CommandCommit, CommandOutcome, EventToWrite, RoomOwnerPrecondition};

/// Stream kind: "other" (see sequencer/mod.rs stream_kind_dir_name).
const STREAM_KIND_OTHER: u8 = 6;

pub async fn create_call_session(
    session_id: String,
    channel_id: String,
    call_type: String,
    host_user_id: u64,
    max_participants: u32,
    transport: String,
    room_owner_precondition: RoomOwnerPrecondition,
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
    let room_id = call_sessions::placement_room_id(&session_id, &channel_id)?.into_owned();
    if room_owner_precondition.channel_id != room_id {
        return Err(WabiError::Validation {
            command: "room_owner_precondition".into(),
            reason: "call creation must carry its parent room's owner condition".into(),
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

    let mut events = vec![EventToWrite {
        stream_id: format!("call_session:{}", session_id),
        event_type: "call_session_created".into(),
        stream_kind: STREAM_KIND_OTHER,
        record_kind: RecordKind::Event,
        plaintext: payload,
    }];
    if call_sessions::direct_pair(&session_id)?.is_some()
        && room_owner_precondition.expected_epoch.is_none()
    {
        let placement = room_placement::RoomPlacementRecord {
            schema_version: 1,
            channel_id: room_id.clone(),
            epoch: 1,
            owner_node_id: room_owner_precondition.owner_node_id.clone(),
            replica_node_ids: vec![],
        };
        events.push(EventToWrite {
            stream_id: room_placement::stream_id(&room_id),
            event_type: room_placement::EVENT.into(),
            stream_kind: STREAM_KIND_OTHER,
            record_kind: RecordKind::Event,
            plaintext: serde_json::to_vec(&placement).map_err(|e| WabiError::Validation {
                command: "call_session_create".into(),
                reason: format!("serialize placement failed: {e}"),
            })?,
        });
    }
    // Call commands bypass the adapter's generic run(), so register both keys.
    for event in &events {
        engine.get_or_create_stream_key(&event.stream_id).await?;
    }

    let (tx, _rx) = tokio::sync::oneshot::channel();
    let cmd = CommandCommit {
        room_owner_precondition: Some(room_owner_precondition),
        caller_user_id: host_user_id,
        caller_device_id: format!("dev_{}", host_user_id),
        command_name: "call_session_create".into(),
        idempotency_key: None,
        events,
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

    async fn setup_engine() -> (tempfile::TempDir, WabiDbEngine) {
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
        (dir, engine)
    }

    fn room_precondition() -> RoomOwnerPrecondition {
        RoomOwnerPrecondition {
            channel_id: "ch_1".into(),
            owner_node_id: "node-1".into(),
            expected_epoch: None,
        }
    }

    #[tokio::test]
    async fn empty_session_id_rejected() {
        let (_dir, engine) = setup_engine().await;
        let sequencer = engine.sequencer().unwrap();
        let result = create_call_session(
            "".into(),
            "ch_1".into(),
            "audio-call".into(),
            1,
            10,
            "webrtc".into(),
            room_precondition(),
            &engine,
            sequencer,
        )
        .await;
        assert!(matches!(result, Err(WabiError::Validation { .. })));
    }

    #[tokio::test]
    async fn empty_channel_id_rejected() {
        let (_dir, engine) = setup_engine().await;
        let sequencer = engine.sequencer().unwrap();
        let result = create_call_session(
            "s_1".into(),
            "".into(),
            "audio-call".into(),
            1,
            10,
            "webrtc".into(),
            room_precondition(),
            &engine,
            sequencer,
        )
        .await;
        assert!(matches!(result, Err(WabiError::Validation { .. })));
    }

    #[tokio::test]
    async fn unrelated_room_condition_is_rejected_before_commit() {
        let (_dir, engine) = setup_engine().await;
        let position = engine.barrier().current();
        let result = create_call_session(
            "s_wrong_parent".into(),
            "ch_other".into(),
            "audio-call".into(),
            1,
            10,
            "webrtc".into(),
            room_precondition(),
            &engine,
            engine.sequencer().unwrap(),
        )
        .await;
        assert!(matches!(result, Err(WabiError::Validation { command, .. })
            if command == "room_owner_precondition"));
        assert_eq!(engine.barrier().current(), position);
    }

    #[tokio::test]
    async fn happy_path_creates_session() {
        let (_dir, engine) = setup_engine().await;
        let sequencer = engine.sequencer().unwrap();
        let result = create_call_session(
            "s_1".into(),
            "ch_1".into(),
            "audio-call".into(),
            1,
            10,
            "webrtc".into(),
            room_precondition(),
            &engine,
            sequencer,
        )
        .await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn concurrent_direct_call_creation_has_one_initial_owner_and_replays_both_rows() {
        let (dir, engine) = setup_engine().await;
        let scope = "dm:user-10:user-2";
        let room_id = call_sessions::placement_room_id(scope, scope)
            .unwrap()
            .into_owned();
        let condition = RoomOwnerPrecondition {
            channel_id: room_id.clone(),
            owner_node_id: "node-1".into(),
            expected_epoch: None,
        };
        let create = || {
            create_call_session(
                scope.into(),
                scope.into(),
                "audio-call".into(),
                10,
                2,
                "wabidb".into(),
                condition.clone(),
                &engine,
                engine.sequencer().unwrap(),
            )
        };
        let (first, second) = tokio::join!(create(), create());
        assert_ne!(first.is_ok(), second.is_ok());
        let (accepted, rejected) = if first.is_ok() {
            (first, second)
        } else {
            (second, first)
        };
        let accepted = accepted.unwrap();
        assert!(
            matches!(rejected, Err(WabiError::Validation { command, .. })
            if command == "room_owner_precondition")
        );
        assert_eq!(engine.barrier().current(), accepted.commit_seq);
        let entries =
            crate::commit_index::batcher::read_all_entries(&dir.path().join("global/commit-index"))
                .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].event_refs.len(), 2);
        let state = engine.projection_state();
        let placement = room_placement::decode(
            &state
                .get(room_placement::INDEX, room_id.as_bytes())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(placement.epoch, 1);
        assert_eq!(placement.owner_node_id, "node-1");
        assert!(state.get("channels", room_id.as_bytes()).is_none());
        drop(engine);
        std::fs::remove_file(dir.path().join("projections/snapshot.json")).unwrap();
        let engine = WabiDbEngine::open(WabiDbConfig {
            data_dir: dir.path().to_path_buf(),
            bootstrap_source: BootstrapSource::Provided([0u8; 32]),
            bootstrap_salt: None,
            allow_init: false,
            replication_config: None,
            sync_transport: None,
            test_boot_wallclock_override: None,
        })
        .await
        .unwrap();
        assert_eq!(engine.barrier().current(), accepted.commit_seq);
        let state = engine.projection_state();
        let replayed = call_sessions::decode_value(
            &state
                .get(call_sessions::INDEX_NAME, scope.as_bytes())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(replayed.session_id, scope);
        assert_eq!(replayed.channel_id, scope);
        assert_eq!(
            room_placement::decode(
                &state
                    .get(room_placement::INDEX, room_id.as_bytes())
                    .unwrap()
            )
            .unwrap(),
            placement
        );
        let retry = RoomOwnerPrecondition {
            expected_epoch: Some(1),
            ..condition
        };
        create_call_session(
            scope.into(),
            scope.into(),
            "audio-call".into(),
            10,
            2,
            "wabidb".into(),
            retry,
            &engine,
            engine.sequencer().unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(
            room_placement::decode(
                &state
                    .get(room_placement::INDEX, room_id.as_bytes())
                    .unwrap()
            )
            .unwrap(),
            placement
        );
    }
}
