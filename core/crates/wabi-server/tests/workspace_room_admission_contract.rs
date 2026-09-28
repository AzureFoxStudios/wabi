//! Real adapter encodings must pass the shared database workspace admission.
use wabi_server::adapter::WdbAdapter;
use wabidb::{
    crypto::bootstrap::BootstrapSource,
    domain::ChannelKind,
    engine::{locks::ProjectionState, wabi_store::WabiStore, WabiDbConfig},
    format::record::RecordKind,
    projections::{forum::ForumProjection, incidents::IncidentProjection, room_placement},
    sequencer::types::{CommandCommit, EventToWrite},
};

fn config(path: &std::path::Path) -> WabiDbConfig {
    let mut config = WabiDbConfig::new(path.into(), BootstrapSource::Provided([0xA5; 32]));
    config.allow_init = true;
    config
}

async fn place(store: &WdbAdapter, room: &str, owner: &str) {
    let state = store.engine().projection_state();
    let epoch = room_placement::decode(&state.get(room_placement::INDEX, room.as_bytes()).unwrap())
        .unwrap()
        .epoch
        + 1;
    let stream = room_placement::stream_id(room);
    store
        .engine()
        .get_or_create_stream_key(&stream)
        .await
        .unwrap();
    store
        .engine()
        .run_command(CommandCommit {
            caller_user_id: 0,
            caller_device_id: "workspace-contract".into(),
            command_name: "test_placement".into(),
            idempotency_key: None,
            room_owner_precondition: None,
            essential: true,
            response_tx: tokio::sync::oneshot::channel().0,
            events: vec![EventToWrite {
                event_type: room_placement::EVENT.into(),
                stream_id: stream,
                stream_kind: 6,
                record_kind: RecordKind::Event,
                plaintext: serde_json::to_vec(&room_placement::RoomPlacementRecord {
                    schema_version: 1,
                    channel_id: room.into(),
                    epoch,
                    owner_node_id: owner.into(),
                    replica_node_ids: vec![],
                })
                .unwrap(),
            }],
        })
        .await
        .unwrap();
}

fn rows(state: &ProjectionState) -> Vec<(String, Vec<u8>, Vec<u8>)> {
    let mut result = Vec::new();
    for index in ["forum_posts", "incidents"] {
        state.for_each(index, |key, value| {
            result.push((index.into(), key.to_vec(), value.to_vec()))
        });
    }
    result.sort();
    result
}

#[tokio::test]
async fn forum_and_incident_adapters_keep_local_workflows_and_refuse_remote_mutations() {
    let dir = tempfile::tempdir().unwrap();
    let store = WdbAdapter::open_with_config_and_node_id(config(dir.path()), "site-a".into())
        .await
        .unwrap();
    let forum = store
        .create_channel("Forum", ChannelKind::Forum, 1, false)
        .await
        .unwrap();
    let incident_room = store
        .create_channel("Incidents", ChannelKind::Incident, 1, false)
        .await
        .unwrap();
    let thread = store
        .create_forum_thread(&forum, "Question", 1, Some("Title"), None, None)
        .await
        .unwrap();
    let post = store
        .create_forum_post(&forum, &thread, "Reply", 1, None)
        .await
        .unwrap();
    store
        .update_forum_post(&forum, &thread, &post, "Edited reply", 1, None, None, None)
        .await
        .unwrap();
    store
        .vote_forum_post(&forum, &thread, &post, "up", 1)
        .await
        .unwrap();
    store
        .mark_forum_solution(&forum, &thread, &post, 1)
        .await
        .unwrap();
    store
        .update_forum_thread_meta(
            &forum,
            &thread,
            "New title",
            &["tag".into()],
            Some("help"),
            1,
        )
        .await
        .unwrap();
    let state = store.engine().projection_state();
    let accepted = ForumProjection::get_post(&state, &forum, &thread, &post)
        .unwrap()
        .unwrap();
    assert_eq!(accepted.body, "Edited reply");
    assert_eq!(accepted.votes_up, 1);
    assert!(accepted.is_solution);
    assert_eq!(
        ForumProjection::get_post(&state, &forum, &thread, &thread)
            .unwrap()
            .unwrap()
            .title,
        "New title"
    );
    let incident = store
        .create_incident(&incident_room, "Issue", "Details", "low", 1)
        .await
        .unwrap();
    store
        .update_incident(
            &incident_room,
            &incident,
            "Updated issue",
            "Details",
            "high",
            "open",
            Some(1),
            1,
        )
        .await
        .unwrap();
    store
        .resolve_incident(&incident_room, &incident, 1)
        .await
        .unwrap();
    let accepted = IncidentProjection::get_incident(&state, &incident_room, &incident)
        .unwrap()
        .unwrap();
    assert_eq!(accepted.title, "Updated issue");
    assert_eq!(accepted.status, "resolved");
    assert!(accepted.resolved_at_micros.is_some());

    place(&store, &forum, "site-b").await;
    place(&store, &incident_room, "site-b").await;
    let before = store.engine().barrier().current();
    let expected = rows(&state);
    let count =
        wabidb::commit_index::batcher::read_all_entries(&dir.path().join("global/commit-index"))
            .unwrap()
            .len();
    assert!(store
        .create_forum_thread(&forum, "Must refuse", 1, None, None, None)
        .await
        .is_err());
    assert!(store
        .create_forum_post(&forum, &thread, "Must refuse", 1, None)
        .await
        .is_err());
    assert!(store
        .update_forum_post(&forum, &thread, &post, "Must refuse", 1, None, None, None)
        .await
        .is_err());
    assert!(store
        .vote_forum_post(&forum, &thread, &post, "down", 1)
        .await
        .is_err());
    assert!(store
        .mark_forum_solution(&forum, &thread, &thread, 1)
        .await
        .is_err());
    assert!(store
        .update_forum_thread_meta(&forum, &thread, "Must refuse", &[], None, 1)
        .await
        .is_err());
    assert!(store
        .delete_forum_post(&forum, &thread, &post, 1)
        .await
        .is_err());
    assert!(store
        .create_incident(&incident_room, "Must refuse", "Details", "low", 1)
        .await
        .is_err());
    assert!(store
        .update_incident(
            &incident_room,
            &incident,
            "Must refuse",
            "Details",
            "low",
            "open",
            None,
            1
        )
        .await
        .is_err());
    assert!(store
        .resolve_incident(&incident_room, &incident, 1)
        .await
        .is_err());
    assert_eq!(store.engine().barrier().current(), before);
    assert_eq!(rows(&state), expected);
    assert_eq!(
        wabidb::commit_index::batcher::read_all_entries(&dir.path().join("global/commit-index"))
            .unwrap()
            .len(),
        count
    );

    place(&store, &forum, "site-a").await;
    store
        .delete_forum_post(&forum, &thread, &post, 1)
        .await
        .unwrap();
    assert!(
        ForumProjection::get_post(&state, &forum, &thread, &post)
            .unwrap()
            .unwrap()
            .is_deleted
    );
    let watermark = store.engine().barrier().current();
    let expected = rows(&state);
    drop(state);
    drop(store);
    ProjectionState::remove_snapshot(dir.path());
    let reopened = WdbAdapter::open_with_config_and_node_id(config(dir.path()), "site-a".into())
        .await
        .unwrap();
    assert_eq!(reopened.engine().barrier().current(), watermark);
    assert_eq!(rows(&reopened.engine().projection_state()), expected);
    assert!(reopened.engine().is_healthy());
}
