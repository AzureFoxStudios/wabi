//! Group membership must be a durable aggregate, not a series of fake/live edits.
use wabi_server::adapter::WdbAdapter;
use wabidb::engine::wabi_store::WabiStore;
use wabidb::projections::channel_members::ChannelMembersProjection;

#[tokio::test]
async fn removal_retires_persisted_call_consent_atomically_without_touching_other_calls() {
    for checkpoint in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let store = WdbAdapter::open(dir.path()).await.unwrap();
        let group = "group-call-consent";
        store.create_group(group, "crew", 9, &[9, 2]).await.unwrap();
        for (session, channel) in [
            ("channel:group-call-consent", group),
            ("historic-group-call", group),
            ("unrelated-call", "other"),
        ] {
            store
                .create_call_session(
                    session.into(),
                    channel.into(),
                    "audio-call".into(),
                    9,
                    8,
                    "wabidb".into(),
                )
                .await
                .unwrap();
            for uid in [9, 2] {
                store
                    .join_call_session(session.into(), uid, format!("user-{uid}"), uid == 9)
                    .await
                    .unwrap();
            }
        }
        store
            .end_call_session("historic-group-call".into(), 9)
            .await
            .unwrap();
        let seq = store
            .change_group_membership(9, group, None, Some(9), 2)
            .await
            .unwrap();
        let commits = wabidb::commit_index::batcher::read_all_entries(
            &dir.path().join("global/commit-index"),
        )
        .unwrap();
        let commit = commits.iter().find(|c| c.commit_seq == seq).unwrap();
        assert_eq!(
            commit.event_refs.len(),
            4,
            "membership, owner transfer and both call departures share the commit"
        );
        for id in ["channel:group-call-consent", "historic-group-call"] {
            let rows = store.get_call_participants(id).await.unwrap();
            assert!(rows
                .iter()
                .find(|p| p.user_id == 9)
                .unwrap()
                .left_at_micros
                .is_some());
            assert!(rows
                .iter()
                .find(|p| p.user_id == 2)
                .unwrap()
                .left_at_micros
                .is_none());
        }
        assert!(
            store
                .get_call_session("channel:group-call-consent")
                .await
                .unwrap()
                .unwrap()
                .active
        );
        assert!(store
            .get_call_participants("unrelated-call")
            .await
            .unwrap()
            .iter()
            .all(|p| p.left_at_micros.is_none()));
        if checkpoint {
            store
                .engine()
                .projection_state()
                .save_snapshot(dir.path())
                .unwrap();
        }
        drop(store);
        let store = WdbAdapter::open(dir.path()).await.unwrap();
        store
            .change_group_membership(2, group, Some(9), None, 2)
            .await
            .unwrap();
        assert!(
            store
                .get_call_participants("channel:group-call-consent")
                .await
                .unwrap()
                .iter()
                .find(|p| p.user_id == 9)
                .unwrap()
                .left_at_micros
                .is_some(),
            "re-add/replay must not restore consent"
        );
        store
            .change_group_membership(2, group, None, Some(9), 2)
            .await
            .unwrap();
        store
            .change_group_membership(2, group, None, Some(2), 0)
            .await
            .unwrap();
        drop(store);
        let store = WdbAdapter::open(dir.path()).await.unwrap();
        assert!(
            !store
                .get_call_session("channel:group-call-consent")
                .await
                .unwrap()
                .unwrap()
                .active
        );
        assert!(store
            .get_call_participants("channel:group-call-consent")
            .await
            .unwrap()
            .iter()
            .all(|p| p.left_at_micros.is_some()));
        assert!(
            store
                .get_call_session("unrelated-call")
                .await
                .unwrap()
                .unwrap()
                .active
        );
        assert!(store
            .get_call_participants("unrelated-call")
            .await
            .unwrap()
            .iter()
            .all(|p| p.left_at_micros.is_none()));
    }
}

#[tokio::test]
async fn corrupt_call_projection_prevents_a_partial_membership_revocation() {
    let dir = tempfile::tempdir().unwrap();
    let store = WdbAdapter::open(dir.path()).await.unwrap();
    let id = "group-corrupt-call";
    let created = store.create_group(id, "crew", 9, &[9, 2]).await.unwrap();
    // Test-only corruption: never write projection rows this way in commands.
    store.engine().projection_state().insert(
        "call_sessions",
        b"bad".to_vec(),
        b"not a call row".to_vec(),
        created,
    );
    assert!(store
        .change_group_membership(9, id, None, Some(2), 9)
        .await
        .is_err());
    assert_eq!(
        ChannelMembersProjection::revision(&store.engine().projection_state(), id).unwrap(),
        created
    );
    assert_eq!(store.list_channel_members(id).await.unwrap().len(), 2);
    assert_eq!(
        wabidb::commit_index::batcher::read_all_entries(&dir.path().join("global/commit-index"))
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn group_creation_commits_owner_and_complete_membership_together() {
    let dir = tempfile::tempdir().unwrap();
    let store = WdbAdapter::open(dir.path()).await.unwrap();
    store
        .create_group("group-atomic", "crew", 9, &[9, 2, 4])
        .await
        .unwrap();
    let group = store.get_channel("group-atomic").await.unwrap().unwrap();
    let members = store.list_channel_members("group-atomic").await.unwrap();
    assert_eq!(
        group.owner_user_id, 9,
        "creator ownership must be persisted, not inferred from index order"
    );
    assert_eq!(members.len(), 3);
    let commits =
        wabidb::commit_index::batcher::read_all_entries(&dir.path().join("global/commit-index"))
            .unwrap();
    assert_eq!(
        commits.len(),
        1,
        "a crash must not commit a partially created group"
    );
    assert_eq!(
        commits[0].event_refs.len(),
        2,
        "channel + one membership batch"
    );
    assert_eq!(
        ChannelMembersProjection::revision(&store.engine().projection_state(), "group-atomic")
            .unwrap(),
        commits[0].commit_seq
    );
    drop(store);
    let reopened = WdbAdapter::open(dir.path()).await.unwrap();
    assert_eq!(
        reopened.get_channel("group-atomic").await.unwrap().unwrap(),
        group
    );
    assert_eq!(
        reopened.list_channel_members("group-atomic").await.unwrap(),
        members
    );
}

#[tokio::test]
async fn membership_delta_owner_succession_and_last_leave_replay_together() {
    for checkpoint in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let store = WdbAdapter::open(dir.path()).await.unwrap();
        store
            .create_group("group-succession", "still the crew", 9, &[9, 2])
            .await
            .unwrap();
        let added = store
            .change_group_membership(9, "group-succession", Some(4), None, 9)
            .await
            .unwrap();
        let left = store
            .change_group_membership(9, "group-succession", None, Some(9), 2)
            .await
            .unwrap();
        assert!(left > added);
        assert_eq!(
            store
                .get_channel("group-succession")
                .await
                .unwrap()
                .unwrap()
                .owner_user_id,
            2
        );
        assert_eq!(
            store
                .list_channel_members("group-succession")
                .await
                .unwrap()
                .iter()
                .map(|m| m.user_id)
                .collect::<Vec<_>>(),
            vec![2, 4]
        );
        if checkpoint {
            store
                .engine()
                .projection_state()
                .save_snapshot(dir.path())
                .unwrap();
        }
        drop(store);
        let store = WdbAdapter::open(dir.path()).await.unwrap();
        let group = store
            .get_channel("group-succession")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            (group.name.as_str(), group.owner_user_id),
            ("still the crew", 2)
        );
        assert_eq!(
            ChannelMembersProjection::revision(
                &store.engine().projection_state(),
                &group.channel_id
            )
            .unwrap(),
            left
        );
        store
            .change_group_membership(2, &group.channel_id, None, Some(4), 2)
            .await
            .unwrap();
        let retired = store
            .change_group_membership(2, &group.channel_id, None, Some(2), 0)
            .await
            .unwrap();
        assert!(store
            .get_channel(&group.channel_id)
            .await
            .unwrap()
            .is_none());
        assert!(store
            .list_channel_members(&group.channel_id)
            .await
            .unwrap()
            .is_empty());
        drop(store);
        let store = WdbAdapter::open(dir.path()).await.unwrap();
        assert!(store
            .get_channel(&group.channel_id)
            .await
            .unwrap()
            .is_none());
        assert!(store
            .list_channel_members(&group.channel_id)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            ChannelMembersProjection::revision(
                &store.engine().projection_state(),
                &group.channel_id
            )
            .unwrap(),
            retired
        );
        let commits = wabidb::commit_index::batcher::read_all_entries(
            &dir.path().join("global/commit-index"),
        )
        .unwrap();
        assert_eq!(commits.len(), 5);
        assert!(commits.iter().all(|c| c.event_refs.len() == 2));
    }
}

#[tokio::test]
async fn invalid_group_commands_never_commit_or_overwrite_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let store = WdbAdapter::open(dir.path()).await.unwrap();
    for (id, name, owner, members) in [
        ("group-../escape", "crew", 9, vec![9, 2]),
        ("group-invalid", "", 9, vec![9, 2]),
        ("group-invalid", "crew", 9, vec![9, 9]),
        ("group-invalid", "crew", 9, vec![9, 0]),
        ("group-invalid", "crew", 4, vec![9, 2]),
    ] {
        assert!(store.create_group(id, name, owner, &members).await.is_err());
    }
    assert!(store.list_channels(None).await.unwrap().is_empty());
    let created = store
        .create_group("group-valid", "keep this name", 9, &[9, 2])
        .await
        .unwrap();
    assert!(store
        .create_group("group-valid", "overwrite", 2, &[2, 4])
        .await
        .is_err());
    assert!(store
        .change_group_membership(9, "group-valid", None, Some(9), 9)
        .await
        .is_err());
    assert!(store
        .change_group_membership(9, "group-valid", Some(4), Some(4), 9)
        .await
        .is_err());
    assert!(store
        .change_group_membership(9, "group-valid", Some(0), None, 9)
        .await
        .is_err());
    assert!(store
        .change_group_membership(9, "group-valid", Some(2), None, 9)
        .await
        .is_err());
    assert!(store
        .change_group_membership(9, "group-valid", None, None, 9)
        .await
        .is_err());
    assert_eq!(
        store
            .get_channel("group-valid")
            .await
            .unwrap()
            .unwrap()
            .name,
        "keep this name"
    );
    assert_eq!(
        store
            .list_channel_members("group-valid")
            .await
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        store.engine().projection_state().applied_commit_seq(),
        created
    );
    assert!(
        store.is_healthy(),
        "bad commands must be rejected before reaching projections"
    );
}

#[tokio::test]
async fn legacy_snapshot_repair_understands_batch_readds_without_resurrecting_removals() {
    use wabidb::projections::channel_members::{encode_key, encode_record, ChannelMemberRecord};
    let dir = tempfile::tempdir().unwrap();
    let store = WdbAdapter::open(dir.path()).await.unwrap();
    store
        .create_group("group-legacy", "legacy repair", 9, &[9, 2, 4])
        .await
        .unwrap();
    store
        .remove_channel_member("group-legacy", 2)
        .await
        .unwrap();
    store
        .change_group_membership(9, "group-legacy", Some(2), Some(4), 9)
        .await
        .unwrap();
    let projection = store.engine().projection_state();
    // Reconstruct a legacy stale-row/ignored-removal checkpoint marker. This
    // deliberately tests compatibility repair, not normal live projection use.
    let stale = ChannelMemberRecord {
        channel_id: "group-legacy".into(),
        user_id: 4,
        joined_at_micros: 1,
        role: 0,
        nick: None,
    };
    let seq = projection.applied_commit_seq();
    projection.insert(
        "channel_members",
        encode_key("group-legacy", 4),
        encode_record(&stale),
        seq,
    );
    projection.insert(
        "events",
        b"channel_member_removed".to_vec(),
        encode_record(&stale),
        seq,
    );
    projection.save_snapshot(dir.path()).unwrap();
    drop(store);
    let store = WdbAdapter::open(dir.path()).await.unwrap();
    let ids = store
        .list_channel_members("group-legacy")
        .await
        .unwrap()
        .iter()
        .map(|m| m.user_id)
        .collect::<Vec<_>>();
    assert_eq!(ids, vec![2, 9]);
    assert!(store
        .engine()
        .projection_state()
        .get("events", b"channel_member_removed")
        .is_none());
}
