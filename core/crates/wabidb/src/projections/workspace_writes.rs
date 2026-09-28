//! Parent-room admission for new channel-stream workspace commands.
//! Historical events continue through their existing replay handlers.

use crate::{
    engine::locks::ProjectionState,
    error::{Result, WabiError},
    format::record::RecordKind,
    projections::{
        forum, gallery, incidents, project_runs, project_tasks, room_placement, room_writes, wiki,
    },
    sequencer::types::{EventToWrite, RoomOwnerPrecondition},
};

/// Shared by the adapter and sequencer. These events use their payload's
/// channel ID as the stream, rather than a separate object stream.
pub fn is_room_event(event_type: &str) -> bool {
    matches!(
        event_type,
        "wiki_page_created"
            | "wiki_revision_created"
            | "wiki_page_edited"
            | "wiki_page_deleted"
            | "forum_thread_created"
            | "forum_post_created"
            | "forum_post_edited"
            | "forum_post_deleted"
            | "forum_post_voted"
            | "forum_post_solution_set"
            | "forum_thread_meta_updated"
            | "incident_created"
            | "incident_updated"
            | "incident_resolved"
            | "gallery_work_uploaded"
            | "gallery_work_edited"
            | "gallery_work_deleted"
            | "gallery_feedback_added"
            | "gallery_feedback_deleted"
            | "project_run_updated"
            | "project_task_created"
            | "project_task_updated"
    )
}

fn invalid(reason: &str) -> WabiError {
    WabiError::Validation {
        command: "room_owner_precondition".into(),
        reason: reason.into(),
    }
}

fn parent_room(event: &EventToWrite) -> Result<String> {
    let bytes = &event.plaintext;
    let room = match event.event_type.as_str() {
        "wiki_page_created" | "wiki_page_edited" | "wiki_page_deleted" => {
            wiki::decode_record(bytes)?.channel_id
        }
        "wiki_revision_created" => wiki::decode_revision_record(bytes)?.channel_id,
        "forum_thread_created"
        | "forum_post_created"
        | "forum_post_edited"
        | "forum_post_deleted"
        | "forum_thread_meta_updated" => forum::decode_record(bytes)?.channel_id,
        "forum_post_voted" => forum::decode_vote(bytes)?.channel_id,
        "forum_post_solution_set" => forum::decode_solution(bytes)?.channel_id,
        "incident_created" | "incident_updated" | "incident_resolved" => {
            incidents::decode_record(bytes)?.channel_id
        }
        "gallery_work_uploaded" | "gallery_work_edited" | "gallery_work_deleted" => {
            gallery::decode_record(bytes)?.channel_id
        }
        "gallery_feedback_added" | "gallery_feedback_deleted" => {
            gallery::decode_feedback_record(bytes)?.channel_id
        }
        "project_run_updated" => project_runs::decode(bytes)?.channel_id,
        "project_task_created" | "project_task_updated" => {
            project_tasks::decode_record(bytes)?.channel_id
        }
        _ => return Err(invalid("unsupported workspace room event")),
    };
    Ok(room)
}

pub(crate) fn preflight_command(
    events: &[EventToWrite],
    condition: Option<&RoomOwnerPrecondition>,
    state: &ProjectionState,
) -> Result<()> {
    let has_workspace = events.iter().any(|event| is_room_event(&event.event_type));
    if !has_workspace {
        return Ok(());
    }
    if events.iter().any(|event| {
        matches!(
            event.event_type.as_str(),
            room_placement::EVENT | room_placement::INIT_EVENT
        )
    }) {
        return Err(invalid(
            "placement changes and workspace writes require separate commands",
        ));
    }
    for event in events
        .iter()
        .filter(|event| is_room_event(&event.event_type))
    {
        if event.record_kind != RecordKind::Event || event.stream_kind != 6 {
            return Err(invalid("invalid workspace write record or stream kind"));
        }
        let room = parent_room(event).map_err(|_| invalid("invalid workspace write payload"))?;
        if event.stream_id != room {
            return Err(invalid(
                "workspace write stream does not match its parent room",
            ));
        }
        room_writes::bind(&room, condition, state)?;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::projections::handler::Projection;

    /// Actual legacy-compatible record encodings for every supported event.
    /// Keep the two forum action tuples in the historical field order.
    pub(crate) fn events(room: &str) -> Vec<EventToWrite> {
        let page = wiki::encode_record(&wiki::WikiPageRecord {
            page_id: "page_a".into(),
            channel_id: room.into(),
            title: "Page".into(),
            body: "Body".into(),
            author_user_id: 1,
            created_at_micros: 1,
            updated_at_micros: 2,
            is_deleted: false,
            parent_page_id: String::new(),
            slug: "page".into(),
            order_index: 0,
        });
        let revision = wiki::encode_revision_record(&wiki::WikiRevisionRecord {
            revision_id: "revision_a".into(),
            page_id: "page_a".into(),
            channel_id: room.into(),
            editor_user_id: 1,
            title: "Page".into(),
            body: "Body".into(),
            summary: "Edit".into(),
            created_at_micros: 2,
        });
        let post = forum::encode_record(&forum::ForumPostRecord {
            post_id: "post_a".into(),
            thread_id: "thread_a".into(),
            channel_id: room.into(),
            author_user_id: 1,
            body: "Body".into(),
            created_at_micros: 1,
            edited_at_micros: Some(2),
            is_deleted: false,
            is_thread_starter: true,
            title: "Thread".into(),
            tags: vec![],
            votes_up: 0,
            votes_down: 0,
            is_solution: false,
            category: None,
        });
        let vote = postcard::to_allocvec(&("post_a", "thread_a", room, "up", 1u64)).unwrap();
        let solution = postcard::to_allocvec(&("post_a", "thread_a", room, 1u64)).unwrap();
        let incident = incidents::encode_record(&incidents::IncidentRecord {
            incident_id: "incident_a".into(),
            channel_id: room.into(),
            title: "Incident".into(),
            description: "Details".into(),
            severity: "low".into(),
            status: "open".into(),
            reporter_user_id: 1,
            assigned_user_id: None,
            created_at_micros: 1,
            updated_at_micros: 2,
            resolved_at_micros: None,
            is_deleted: false,
        });
        let work = gallery::encode_record(&gallery::GalleryWorkRecord {
            work_id: "work_a".into(),
            channel_id: room.into(),
            author_user_id: 1,
            title: "Work".into(),
            caption: "Caption".into(),
            attachment_url: "/uploads/a".into(),
            mime_type: "image/png".into(),
            category: "art".into(),
            is_wip: false,
            created_at_micros: 1,
            updated_at_micros: 2,
            is_deleted: false,
        });
        let feedback = gallery::encode_feedback_record(&gallery::GalleryFeedbackRecord {
            feedback_id: "feedback_a".into(),
            work_id: "work_a".into(),
            channel_id: room.into(),
            author_user_id: 1,
            comment: "Feedback".into(),
            x_percent: 0.5,
            y_percent: 0.5,
            created_at_micros: 1,
            is_deleted: false,
        });
        let task = project_tasks::encode_record(&project_tasks::ProjectTaskRecord {
            notes: String::new(),
            checklist: vec![],
            related_task_ids: vec![],
            human_estimate_minutes: None,
            task_id: "task_a".into(),
            channel_id: room.into(),
            title: "Task".into(),
            description: "Details".into(),
            status: "todo".into(),
            priority: "normal".into(),
            due_date_millis: None,
            assignee_user_id: None,
            created_by_user_id: 1,
            updated_by_user_id: 1,
            created_at_micros: 1,
            updated_at_micros: 2,
            revision: 1,
            is_archived: false,
        });
        let run = project_runs::encode(&project_runs::ProjectRun {
            schema_version: 1,
            run_id: "run_a".into(),
            channel_id: room.into(),
            created_by_user_id: 1,
            bot_user_id: 2,
            mode: "chat".into(),
            prompt: "Prompt".into(),
            reply: String::new(),
            status: "queued".into(),
            revision: 1,
            attempt: 0,
            lease_until_micros: 0,
            created_at_micros: 1,
            updated_at_micros: 1,
            provider: "test".into(),
            model: "test".into(),
            checkpoint: String::new(),
            pending: None,
            steps: vec![],
        });
        [
            ("wiki_page_created", &page),
            ("wiki_revision_created", &revision),
            ("wiki_page_edited", &page),
            ("wiki_page_deleted", &page),
            ("forum_thread_created", &post),
            ("forum_post_created", &post),
            ("forum_post_edited", &post),
            ("forum_post_deleted", &post),
            ("forum_post_voted", &vote),
            ("forum_post_solution_set", &solution),
            ("forum_thread_meta_updated", &post),
            ("incident_created", &incident),
            ("incident_updated", &incident),
            ("incident_resolved", &incident),
            ("gallery_work_uploaded", &work),
            ("gallery_work_edited", &work),
            ("gallery_work_deleted", &work),
            ("gallery_feedback_added", &feedback),
            ("gallery_feedback_deleted", &feedback),
            ("project_task_created", &task),
            ("project_task_updated", &task),
            ("project_run_updated", &run),
        ]
        .into_iter()
        .map(|(kind, bytes)| EventToWrite {
            event_type: kind.into(),
            stream_id: room.into(),
            plaintext: bytes.clone(),
            stream_kind: 6,
            record_kind: RecordKind::Event,
        })
        .collect()
    }

    pub(crate) fn legacy_task_events(room: &str) -> Vec<EventToWrite> {
        events(room)
            .into_iter()
            .filter(|event| {
                matches!(
                    event.event_type.as_str(),
                    "project_task_created" | "project_task_updated"
                )
            })
            .map(|mut event| {
                let row = project_tasks::decode_record(&event.plaintext).unwrap();
                event.plaintext = postcard::to_allocvec(&project_tasks::LegacyProjectTaskRecord {
                    task_id: row.task_id,
                    channel_id: row.channel_id,
                    title: row.title,
                    description: row.description,
                    status: row.status,
                    priority: row.priority,
                    due_date_millis: row.due_date_millis,
                    assignee_user_id: row.assignee_user_id,
                    created_by_user_id: row.created_by_user_id,
                    updated_by_user_id: row.updated_by_user_id,
                    created_at_micros: row.created_at_micros,
                    updated_at_micros: row.updated_at_micros,
                    revision: row.revision,
                    is_archived: row.is_archived,
                })
                .unwrap();
                event
            })
            .collect()
    }

    pub(crate) fn copy(event: &EventToWrite) -> EventToWrite {
        EventToWrite {
            event_type: event.event_type.clone(),
            stream_id: event.stream_id.clone(),
            plaintext: event.plaintext.clone(),
            stream_kind: event.stream_kind,
            record_kind: event.record_kind,
        }
    }

    pub(crate) fn guard(room: &str) -> RoomOwnerPrecondition {
        RoomOwnerPrecondition {
            channel_id: room.into(),
            owner_node_id: "site-a".into(),
            expected_epoch: Some(1),
        }
    }

    pub(crate) fn placement(room: &str, owner: &str, epoch: u64) -> EventToWrite {
        EventToWrite {
            event_type: room_placement::EVENT.into(),
            stream_id: room_placement::stream_id(room),
            plaintext: serde_json::to_vec(&room_placement::RoomPlacementRecord {
                schema_version: 1,
                channel_id: room.into(),
                epoch,
                owner_node_id: owner.into(),
                replica_node_ids: vec![],
            })
            .unwrap(),
            stream_kind: 6,
            record_kind: RecordKind::Event,
        }
    }

    #[test]
    fn event_catalog_matches_all_five_workspace_projections() {
        let handlers: Vec<Box<dyn Projection>> = vec![
            Box::new(wiki::WikiProjection),
            Box::new(wiki::WikiRevisionProjection),
            Box::new(forum::ForumProjection),
            Box::new(incidents::IncidentProjection),
            Box::new(gallery::GalleryWorkProjection),
            Box::new(gallery::GalleryFeedbackProjection),
            Box::new(project_tasks::ProjectTaskProjection),
            Box::new(project_runs::ProjectRunProjection),
        ];
        let mut registered: Vec<_> = handlers
            .iter()
            .flat_map(|handler| handler.event_types())
            .collect();
        registered.sort();
        let fixture_events = events("ch_a");
        let mut covered: Vec<_> = fixture_events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect();
        covered.sort();
        assert_eq!(registered, covered);
        assert_eq!(covered.len(), 22);
        assert!(covered.iter().all(|event| is_room_event(event)));
        assert!(!is_room_event("user_registered"));
    }

    #[test]
    fn every_workspace_event_binds_payload_stream_and_owner_room() {
        let state = ProjectionState::new();
        let placed = placement("ch_actual", "site-a", 1);
        state.insert(
            room_placement::INDEX,
            b"ch_actual".to_vec(),
            placed.plaintext,
            1,
        );
        for event in events("ch_actual")
            .into_iter()
            .chain(legacy_task_events("ch_actual"))
        {
            let one = std::slice::from_ref(&event);
            assert!(
                preflight_command(one, Some(&guard("ch_actual")), &state).is_ok(),
                "{}",
                event.event_type
            );
            assert!(
                preflight_command(one, None, &state).is_err(),
                "{}",
                event.event_type
            );
            assert!(
                preflight_command(one, Some(&guard("ch_other")), &state).is_err(),
                "{}",
                event.event_type
            );
            let mut wrong = copy(&event);
            wrong.stream_id = "ch_other".into();
            assert!(preflight_command(&[wrong], Some(&guard("ch_actual")), &state).is_err());
            let mut wrong = copy(&event);
            wrong.record_kind = RecordKind::Snapshot;
            assert!(preflight_command(&[wrong], Some(&guard("ch_actual")), &state).is_err());
            let mut wrong = copy(&event);
            wrong.stream_kind = 1;
            assert!(preflight_command(&[wrong], Some(&guard("ch_actual")), &state).is_err());
            let mut wrong = event;
            wrong.plaintext.clear();
            assert!(preflight_command(&[wrong], Some(&guard("ch_actual")), &state).is_err());
        }
    }

    #[test]
    fn unplaced_legacy_rooms_keep_compatibility_without_ignoring_wrong_conditions() {
        let state = ProjectionState::new();
        for event in events("ch_legacy")
            .into_iter()
            .chain(legacy_task_events("ch_legacy"))
        {
            let one = std::slice::from_ref(&event);
            assert!(preflight_command(one, None, &state).is_ok());
            assert!(preflight_command(one, Some(&guard("ch_other")), &state).is_err());
        }
        for room in ["", "ch_\n", &"a".repeat(513)] {
            for event in events(room) {
                assert!(preflight_command(&[event], None, &state).is_err());
            }
        }
    }

    #[test]
    fn placement_and_workspace_commands_cannot_bypass_applied_owner_checks() {
        let state = ProjectionState::new();
        for event in events("ch_a") {
            for init in [room_placement::EVENT, room_placement::INIT_EVENT] {
                let mut control = placement("ch_a", "site-b", 1);
                control.event_type = init.into();
                for mixed in [
                    vec![copy(&control), copy(&event)],
                    vec![copy(&event), control],
                ] {
                    assert!(preflight_command(&mixed, None, &state).is_err());
                }
            }
        }
        // A non-room control event remains outside this module's contract.
        let mut global = events("global").remove(0);
        global.event_type = "unrelated_control_event".into();
        assert!(preflight_command(&[global], None, &state).is_ok());
    }
}
