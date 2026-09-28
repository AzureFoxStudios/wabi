//! Runtime participant-permission refresh for an already connected media room.
//!
//! Voice moderation owns policy; media backends own packet enforcement. This
//! module bridges the two through the existing targeted MediaRelay job queue so
//! moderation code never needs LiveKit/mediasoup root credentials.

use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    sync::Arc,
};
use wabidb::engine::wabi_store::WabiStore;

use crate::{
    api::{media_node_catalog, voice_policy::VoiceAdmission},
    jobs::{JobKind, SubmitJobRequest},
    state::AppState,
};

fn livekit_device_identity(user_id: i64, socket_id: &str) -> String {
    let mut hasher = DefaultHasher::new();
    socket_id.hash(&mut hasher);
    format!("user:{user_id}:device:{:016x}", hasher.finish())
}

/// Queue a backend permission refresh for one exact admitted device.
///
/// Missing/inactive non-LiveKit rooms are a successful no-op: durable Wabi
/// policy still governs the next token. A configured LiveKit room receives an
/// immediate UpdateParticipant job so a moderation change does not wait for
/// token expiry.
pub async fn refresh_participant_permissions(
    state: &Arc<AppState>,
    admission: &VoiceAdmission,
) -> Result<(), String> {
    let Some(room) = state.media_registry.find_by_channel(&admission.channel_id).await else {
        return Ok(());
    };
    let Some(node_id) = room.assigned_node_id.clone() else {
        return Ok(());
    };
    let Some(record) = media_node_catalog::global(&state.config.data_dir).get(&node_id).await else {
        return Ok(());
    };
    if record.advertisement.provider != "livekit" {
        return Ok(());
    }

    let server_muted = state
        .wdb
        .is_user_muted(&admission.channel_id, admission.user_id as u64)
        .await
        .unwrap_or(admission.server_muted);
    let server_deafened = state
        .wdb
        .is_user_deafened(&admission.channel_id, admission.user_id as u64)
        .await
        .unwrap_or(admission.server_deafened);

    let can_publish = !admission.listening_only;
    let sources = if !can_publish {
        serde_json::json!([])
    } else if server_muted {
        serde_json::json!(["camera", "screen_share", "screen_share_audio"])
    } else {
        serde_json::json!(["microphone", "camera", "screen_share", "screen_share_audio"])
    };
    let payload = serde_json::json!({
        "operation": "update_participant_permissions",
        "tenantNamespace": room.tenant_namespace,
        "roomId": room.room_id,
        "externalRoomName": room.external_room_name,
        "channelId": room.channel_id,
        "assignedNodeId": node_id,
        "identity": livekit_device_identity(admission.user_id, &admission.socket_id),
        "grants": {
            "canPublish": can_publish,
            "canSubscribe": !server_deafened,
            "canPublishData": true,
            "canPublishSources": sources,
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn per_device_identity_is_stable_and_device_scoped() {
        let a1 = livekit_device_identity(7, "socket-a");
        let a2 = livekit_device_identity(7, "socket-a");
        let b = livekit_device_identity(7, "socket-b");
        assert_eq!(a1, a2);
        assert_ne!(a1, b);
        assert!(a1.starts_with("user:7:device:"));
    }
}
