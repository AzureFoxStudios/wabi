//! Runtime participant-permission refresh for an already connected media room.
//!
//! Voice moderation owns policy; media backends own packet enforcement. This
//! module bridges the two through the existing targeted MediaRelay job queue so
//! moderation code never needs LiveKit root credentials. Queueing an update
//! is not confirmation that a helper applied it or that an old token expired.

use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    sync::Arc,
};

pub(crate) fn livekit_device_identity(user_id: i64, socket_id: &str) -> String {
    let mut hasher = DefaultHasher::new();
    socket_id.hash(&mut hasher);
    format!("user:{user_id}:device:{:016x}", hasher.finish())
}
use wabidb::engine::wabi_store::WabiStore;

use crate::{
    api::media_node_catalog,
    jobs::{JobKind, SubmitJobRequest},
    state::AppState,
};

/// Queue a permission refresh for the current broker's account identity.
///
/// Missing/closed/unassigned or non-LiveKit rooms are a successful no-op.
/// The caller serializes the durable moderation change and this queue write
/// with voice admission; this helper must not reacquire that membership gate.
/// A queued UpdateParticipant job is best effort, not a revocation receipt.
pub async fn refresh_participant_permissions(
    state: &Arc<AppState>,
    channel_id: &str,
    user_id: i64,
) -> Result<(), String> {
    if user_id <= 0 {
        return Err("Invalid media participant identity".into());
    }
    let Some(room) = state.media_registry.find_by_channel(channel_id).await else {
        return Ok(());
    };
    let Some(node_id) = room.assigned_node_id.clone() else {
        return Ok(());
    };
    let Some(record) = media_node_catalog::global(&state.config.data_dir)
        .get(&node_id)
        .await
    else {
        return Ok(());
    };
    if record.advertisement.provider != "livekit" {
        return Ok(());
    }

    let server_muted = state.wdb.is_user_muted(channel_id, user_id as u64).await;
    let server_deafened = state.wdb.is_user_deafened(channel_id, user_id as u64).await;

    // A corrupt read must not reuse a formerly permissive cached grant.
    // Queue a deny-all update for the current account identity, then report
    // the failure so moderation cannot falsely confirm successful enforcement.
    let unavailable = server_muted.is_err() || server_deafened.is_err();
    let server_muted = server_muted.unwrap_or(true);
    let server_deafened = server_deafened.unwrap_or(true);
    let can_publish = !unavailable && !server_muted;
    let sources = if can_publish {
        serde_json::json!(["microphone", "camera", "screen_share", "screen_share_audio"])
    } else {
        serde_json::json!([])
    };
    // A registry entry alone cannot recover an expired connection's grant.
    // Scope to this Authority and retain only its current live devices.
    let live_devices = state
        .socket_io()
        .map(|io| {
            io.sockets()
                .into_iter()
                .filter(|socket| {
                    socket
                        .extensions
                        .get::<crate::socketio::SioIdentity>()
                        .is_some_and(|identity| identity.user_id == user_id)
                })
                .map(|socket| socket.id.to_string())
                .collect::<std::collections::HashSet<_>>()
        })
        .unwrap_or_default();
    let devices =
        crate::api::voice_policy::account_admissions(&state.config.data_dir, channel_id, user_id)
            .into_iter()
            .filter(|device| live_devices.contains(&device.socket_id))
            .collect::<Vec<_>>();
    let identities =
        std::iter::once((format!("user:{user_id}"), false)).chain(devices.iter().map(|device| {
            (
                livekit_device_identity(user_id, &device.socket_id),
                device.listening_only,
            )
        }));
    for (identity, listening_only) in identities {
        let device_publish = can_publish && !listening_only;
        let payload = serde_json::json!({
            "operation": "update_participant_permissions",
            "tenantNamespace": room.tenant_namespace,
            "roomId": room.room_id,
            "externalRoomName": room.external_room_name,
            "channelId": room.channel_id,
            "assignedNodeId": node_id,
            "identity": identity,
            "grants": {
                "canPublish": device_publish,
                "canSubscribe": !unavailable && !server_deafened,
                "canPublishData": !unavailable,
                "canPublishSources": if device_publish { sources.clone() } else { serde_json::json!([]) },
            }
        });
        state
            .job_queue
            .submit(SubmitJobRequest {
                kind: JobKind::MediaRelay,
                payload,
                max_retries: 2,
            })
            .await;
    }
    if unavailable {
        Err("Voice restrictions could not be read; a deny-all permission update was queued".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn device_identity_is_stable_and_separates_tabs() {
        assert_eq!(
            livekit_device_identity(7, "a"),
            livekit_device_identity(7, "a")
        );
        assert_ne!(
            livekit_device_identity(7, "a"),
            livekit_device_identity(7, "b")
        );
        assert_ne!(
            livekit_device_identity(7, "a"),
            livekit_device_identity(8, "a")
        );
    }
}
