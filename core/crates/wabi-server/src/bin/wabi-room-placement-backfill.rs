//! Stopped-Authority migration of legacy rooms and direct calls into epoch-one
//! placement records. This is not a room move or a multi-owner control plane.

use anyhow::{bail, ensure, Context, Result};
use clap::Parser;
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use wabi_server::{adapter::WdbAdapter, config::valid_node_id};
use wabidb::{
    engine::wabi_store::WabiStore,
    format::record::RecordKind,
    projections::{
        call_sessions,
        room_placement::{decode, stream_id, RoomPlacementRecord, EVENT, INDEX},
    },
    sequencer::types::{CommandCommit, EventToWrite},
};

#[derive(Clone, Parser)]
#[command(about = "Preview or backfill room placements while the Authority is stopped")]
struct Args {
    /// Authority data directory containing wabidb/.
    #[arg(long)]
    data_dir: PathBuf,
    /// Stable WABI_NODE_ID that the Authority will use on its next start.
    #[arg(long)]
    node_id: String,
    /// Maximum missing room/direct-call placements to migrate in one commit.
    #[arg(long, default_value_t = 100)]
    limit: usize,
    /// Commit placement events; omission previews without adding events.
    #[arg(long)]
    apply: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    applied: bool,
    active_rooms: usize,
    direct_call_scopes: usize,
    placement_scopes: usize,
    already_placed: usize,
    selected: usize,
    remaining: usize,
    complete: bool,
}

fn regular_file(path: &Path, description: &str) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path)
        .with_context(|| format!("{description} is missing: {}", path.display()))?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "{description} must be a regular file: {}",
        path.display()
    );
    Ok(())
}

fn real_directory(path: &Path, description: &str) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path)
        .with_context(|| format!("{description} is missing: {}", path.display()))?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "{description} must be a real directory: {}",
        path.display()
    );
    Ok(())
}

async fn run(args: Args) -> Result<Report> {
    ensure!(valid_node_id(&args.node_id), "invalid --node-id");
    ensure!(
        (1..=1_000).contains(&args.limit),
        "--limit must be 1..=1000"
    );
    real_directory(&args.data_dir, "Authority data directory")?;
    let wdb_dir = args.data_dir.join("wabidb");
    real_directory(&wdb_dir, "WabiDB directory")?;
    regular_file(&wdb_dir.join("storage-manifest.json"), "WabiDB manifest")?;
    let has_external_key = std::env::var("WABIDB_ROOT_KEY")
        .ok()
        .is_some_and(|value| !value.trim().is_empty());
    if !has_external_key {
        regular_file(&wdb_dir.join("root_key"), "WabiDB root key")?;
    }
    if args.apply {
        for marker in ["writer-fenced-v1", "activation-pending-v1"] {
            match std::fs::symlink_metadata(wdb_dir.join(marker)) {
                Ok(_) => bail!("refusing to backfill a fenced or inactive Authority"),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
    }

    // Opening WabiDB takes its exclusive engine lock, even for preview.
    let adapter = WdbAdapter::open_with_node_id(&wdb_dir, args.node_id.clone()).await?;
    if args.apply && adapter.engine().local_writer_fenced().await {
        bail!("refusing to backfill a writer-fenced WabiDB");
    }
    let channels = adapter.list_channels(None).await?;
    let mut scopes = BTreeSet::new();
    for channel in &channels {
        ensure!(
            !channel
                .channel_id
                .starts_with(call_sessions::DIRECT_PLACEMENT_PREFIX),
            "legacy Channel {} uses the reserved direct-call placement namespace",
            channel.channel_id
        );
        scopes.insert(channel.channel_id.clone());
    }
    // Collect before querying another index: for_each holds an index lock.
    let mut call_rows = Vec::new();
    adapter
        .engine()
        .projection_state()
        .for_each(call_sessions::INDEX_NAME, |key, bytes| {
            call_rows.push((key.to_vec(), call_sessions::decode_value(bytes)));
        });
    let mut direct_scopes = BTreeSet::new();
    for (key, session) in call_rows {
        let session = session?;
        ensure!(
            key == call_sessions::encode_key(&session.session_id),
            "legacy call session key does not match its record"
        );
        let room_id = call_sessions::placement_room_id(&session.session_id, &session.channel_id)
            .with_context(|| format!("legacy call {} cannot be placed", session.session_id))?;
        if call_sessions::direct_pair(&session.session_id)?.is_some() {
            ensure!(
                adapter
                    .engine()
                    .projection_state()
                    .get("channels", room_id.as_bytes())
                    .is_none(),
                "direct-call placement {} collides with a legacy Channel record",
                room_id
            );
            direct_scopes.insert(room_id.into_owned());
        }
    }
    scopes.extend(direct_scopes.iter().cloned());
    let mut missing = Vec::new();
    let mut already_placed = 0;
    for room_id in &scopes {
        match adapter
            .engine()
            .projection_state()
            .get(INDEX, room_id.as_bytes())
        {
            Some(bytes) => {
                let placement = decode(&bytes)?;
                ensure!(
                    placement.channel_id == *room_id && placement.owner_node_id == args.node_id,
                    "room {} has a placement for another node or a mismatched key",
                    room_id
                );
                already_placed += 1;
            }
            None => {
                let record = RoomPlacementRecord {
                    schema_version: 1,
                    channel_id: room_id.clone(),
                    epoch: 1,
                    owner_node_id: args.node_id.clone(),
                    replica_node_ids: vec![],
                };
                let payload = serde_json::to_vec(&record)?;
                decode(&payload)
                    .with_context(|| format!("legacy scope {room_id} cannot be placed"))?;
                missing.push((room_id.clone(), payload));
            }
        }
    }
    let selected = missing.len().min(args.limit);
    let remaining = missing.len() - if args.apply { selected } else { 0 };
    if args.apply && selected > 0 {
        let mut events = Vec::with_capacity(selected);
        for (channel_id, payload) in missing.iter().take(selected) {
            let stream = stream_id(channel_id);
            adapter.engine().get_or_create_stream_key(&stream).await?;
            events.push(EventToWrite {
                stream_id: stream,
                event_type: EVENT.into(),
                stream_kind: 6,
                record_kind: RecordKind::Event,
                plaintext: payload.clone(),
            });
        }
        let (response_tx, _response_rx) = tokio::sync::oneshot::channel();
        adapter
            .engine()
            .run_command(CommandCommit {
                room_owner_precondition: None,
                caller_user_id: 0,
                caller_device_id: "offline-room-placement-backfill".into(),
                command_name: "backfill_room_placements".into(),
                idempotency_key: None,
                events,
                essential: true,
                response_tx,
            })
            .await?;
        for (channel_id, _) in missing.iter().take(selected) {
            let bytes = adapter
                .engine()
                .projection_state()
                .get(INDEX, channel_id.as_bytes())
                .with_context(|| format!("placement did not apply for {channel_id}"))?;
            let placement = decode(&bytes)?;
            ensure!(
                placement.epoch == 1 && placement.owner_node_id == args.node_id,
                "placement readback mismatch for {channel_id}"
            );
        }
    }
    Ok(Report {
        applied: args.apply,
        active_rooms: channels.len(),
        direct_call_scopes: direct_scopes.len(),
        placement_scopes: scopes.len(),
        already_placed,
        selected,
        remaining,
        complete: remaining == 0,
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    let report = run(Args::parse()).await?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use wabidb::domain::Channel;

    /// Reproduce rows from a pre-placement snapshot through the unchanged
    /// historic projection handler, rather than weakening current admission.
    async fn legacy_call_snapshot(sessions: &[wabidb::domain::CallSession]) -> tempfile::TempDir {
        use wabidb::projections::handler::{DurableEvent, Projection};
        let dir = tempfile::tempdir().unwrap();
        let store = WdbAdapter::open(&dir.path().join("wabidb")).await.unwrap();
        for session in sessions {
            call_sessions::CallSessionsProjection
                .apply(
                    &DurableEvent {
                        commit_seq: 0,
                        stream_id: format!("call_session:{}", session.session_id),
                        event_type: "call_session_created".into(),
                        payload: call_sessions::encode_value(session).unwrap(),
                    },
                    &store.engine().projection_state(),
                )
                .unwrap();
        }
        drop(store);
        dir
    }

    #[tokio::test]
    async fn stopped_backfill_places_active_and_ended_direct_calls_in_bounded_batches() {
        use wabidb::domain::CallSession;
        let active = CallSession::new(
            "dm:user-1:user-2",
            "dm:user-1:user-2",
            "audio-call",
            1,
            2,
            "wabidb",
        );
        let mut ended = CallSession::new(
            "dm:user-10:user-2",
            "dm:user-10:user-2",
            "audio-call",
            10,
            2,
            "wabidb",
        );
        ended.active = false;
        ended.ended_at_micros = Some(1);
        let dir = legacy_call_snapshot(&[active.clone(), ended.clone()]).await;
        let args = Args {
            data_dir: dir.path().into(),
            node_id: "site-a".into(),
            limit: 1,
            apply: false,
        };
        let preview = run(args.clone()).await.unwrap();
        assert_eq!(preview.active_rooms, 0);
        assert_eq!(preview.direct_call_scopes, 2);
        assert_eq!(preview.placement_scopes, 2);
        assert_eq!(preview.selected, 1);
        assert_eq!(preview.remaining, 2);
        assert!(!preview.complete);
        let first = run(Args {
            apply: true,
            ..args.clone()
        })
        .await
        .unwrap();
        assert_eq!(first.remaining, 1);
        assert!(!first.complete);
        let second = run(Args {
            apply: true,
            ..args.clone()
        })
        .await
        .unwrap();
        assert_eq!(second.already_placed, 1);
        assert!(second.complete);
        let repeated = run(Args {
            apply: true,
            ..args.clone()
        })
        .await
        .unwrap();
        assert_eq!(repeated.already_placed, 2);
        assert_eq!(repeated.selected, 0);
        let store = WdbAdapter::open(&dir.path().join("wabidb")).await.unwrap();
        for session in [&active, &ended] {
            assert_eq!(
                store
                    .get_call_session(&session.session_id)
                    .await
                    .unwrap()
                    .as_ref(),
                Some(session)
            );
            let id =
                call_sessions::placement_room_id(&session.session_id, &session.channel_id).unwrap();
            let record = decode(
                &store
                    .engine()
                    .projection_state()
                    .get(INDEX, id.as_bytes())
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(record.epoch, 1);
            assert_eq!(record.owner_node_id, "site-a");
            assert!(store.get_channel(&id).await.unwrap().is_none());
        }
        drop(store);
        assert!(run(Args {
            node_id: "site-b".into(),
            ..args
        })
        .await
        .is_err());
    }

    #[tokio::test]
    async fn stopped_backfill_refuses_malformed_or_rebound_direct_scopes_before_writing() {
        use wabidb::domain::CallSession;
        for (id, parent) in [
            ("dm:user-2:user-1", "dm:user-2:user-1"),
            ("dm:user-1:user-2", "dm-user-1-user-2"),
            ("ordinary", "dm:user-1:user-2"),
        ] {
            let dir = legacy_call_snapshot(&[
                CallSession::new(
                    "dm:user-1:user-3",
                    "dm:user-1:user-3",
                    "audio-call",
                    1,
                    2,
                    "wabidb",
                ),
                CallSession::new(id, parent, "audio-call", 1, 2, "wabidb"),
            ])
            .await;
            assert!(run(Args {
                data_dir: dir.path().into(),
                node_id: "site-a".into(),
                limit: 100,
                apply: true
            })
            .await
            .is_err());
            let store = WdbAdapter::open(&dir.path().join("wabidb")).await.unwrap();
            assert_eq!(store.engine().projection_state().index_len(INDEX), 0);
            assert_eq!(store.engine().barrier().current(), 0);
        }
    }

    #[tokio::test]
    async fn stopped_backfill_refuses_channel_collisions_and_corrupt_call_keys() {
        use wabidb::domain::CallSession;
        let session = CallSession::new(
            "dm:user-1:user-2",
            "dm:user-1:user-2",
            "audio-call",
            1,
            2,
            "wabidb",
        );
        for collision in [Some(false), Some(true), None] {
            let dir = legacy_call_snapshot(std::slice::from_ref(&session)).await;
            let store = WdbAdapter::open(&dir.path().join("wabidb")).await.unwrap();
            let state = store.engine().projection_state();
            if let Some(inactive) = collision {
                let room_id =
                    call_sessions::placement_room_id(&session.session_id, &session.channel_id)
                        .unwrap();
                let mut channel = Channel::new(room_id.as_ref(), "Legacy collision", 1);
                channel.is_active = !inactive;
                state.insert(
                    "channels",
                    room_id.as_bytes().to_vec(),
                    serde_json::to_vec(&channel).unwrap(),
                    0,
                );
            } else {
                state.insert(
                    call_sessions::INDEX_NAME,
                    b"wrong-key".to_vec(),
                    call_sessions::encode_value(&session).unwrap(),
                    0,
                );
            }
            drop(store);
            assert!(run(Args {
                data_dir: dir.path().into(),
                node_id: "site-a".into(),
                limit: 100,
                apply: true
            })
            .await
            .is_err());
            let store = WdbAdapter::open(&dir.path().join("wabidb")).await.unwrap();
            assert_eq!(store.engine().projection_state().index_len(INDEX), 0);
            assert_eq!(store.engine().barrier().current(), 0);
        }
    }

    #[tokio::test]
    async fn stopped_backfill_previews_applies_and_replays_legacy_room() {
        let dir = tempfile::tempdir().unwrap();
        let wdb_dir = dir.path().join("wabidb");
        let store = WdbAdapter::open(&wdb_dir).await.unwrap();
        store
            .engine()
            .get_or_create_stream_key("channels")
            .await
            .unwrap();
        let (response_tx, _response_rx) = tokio::sync::oneshot::channel();
        let outcome = store
            .engine()
            .run_command(CommandCommit {
                room_owner_precondition: None,
                caller_user_id: 1,
                caller_device_id: "legacy-fixture".into(),
                command_name: "legacy_create_channel".into(),
                idempotency_key: None,
                events: vec![EventToWrite {
                    stream_id: "channels".into(),
                    event_type: "channel_created".into(),
                    stream_kind: 6,
                    record_kind: RecordKind::Event,
                    plaintext: serde_json::to_vec(&Channel::new("", "Legacy", 1)).unwrap(),
                }],
                essential: true,
                response_tx,
            })
            .await
            .unwrap();
        let channel_id = format!("ch_{:x}", outcome.commit_seq);
        assert!(store
            .engine()
            .projection_state()
            .get(INDEX, channel_id.as_bytes())
            .is_none());
        drop(store);

        let args = Args {
            data_dir: dir.path().to_path_buf(),
            node_id: "site-a".into(),
            limit: 100,
            apply: false,
        };
        let preview = run(args.clone()).await.unwrap();
        assert_eq!(preview.active_rooms, 1);
        assert_eq!(preview.selected, 1);
        assert!(!preview.applied);
        assert_eq!(preview.remaining, 1);
        assert!(!preview.complete);
        assert!(dir.path().join("wabidb/root_key").exists());

        let applied = run(Args {
            apply: true,
            ..args.clone()
        })
        .await
        .unwrap();
        assert_eq!(applied.selected, 1);
        assert!(applied.complete);
        let repeated = run(args).await.unwrap();
        assert_eq!(repeated.already_placed, 1);
        assert_eq!(repeated.selected, 0);
        let reopened = WdbAdapter::open_with_node_id(&wdb_dir, "site-a".into())
            .await
            .unwrap();
        let bytes = reopened
            .engine()
            .projection_state()
            .get(INDEX, channel_id.as_bytes())
            .unwrap();
        let record = decode(&bytes).unwrap();
        assert_eq!(record.epoch, 1);
        assert_eq!(record.owner_node_id, "site-a");
        drop(reopened);

        let other_node = run(Args {
            data_dir: dir.path().to_path_buf(),
            node_id: "site-b".into(),
            limit: 100,
            apply: false,
        })
        .await;
        assert!(
            other_node.is_err(),
            "a different local owner must be refused"
        );

        std::fs::write(wdb_dir.join("writer-fenced-v1"), b"fenced").unwrap();
        let fenced = run(Args {
            data_dir: dir.path().to_path_buf(),
            node_id: "site-a".into(),
            limit: 100,
            apply: true,
        })
        .await;
        assert!(fenced.is_err(), "a fenced Authority must not be changed");
    }
}
