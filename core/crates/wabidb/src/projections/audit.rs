//! Audit-log projection: stores RBAC, channel-settings, and payment
//! events in a structured `"audit"` index for compliance and debugging.
//!
//! Events that have no dedicated projection handler are catch-all-stored
//! in the generic `"events"` index by the dispatcher fallback. This
//! projection is a structured, queryable view over the events that are
//! most relevant for audit: role changes, channel configuration changes,
//! and payment operations.
//!
//! ## Event types handled
//!
//! | Event type | Source |
//! |---|---|
//! | `role_assigned` | `ingest_event("rbac", "assign_role", ...)` |
//! | `role_removed` | `ingest_event("rbac", "remove_role", ...)` |
//! | `channel_settings_updated` | `ingest_event("channel", "update_settings", ...)` |
//!
//! Payment events (`payment_*`) are stored in the generic `"events"` index
//! by the dispatcher's fallback path (no dedicated audit handler needed).

use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::handler::{DurableEvent, Projection};
use serde::{Deserialize, Serialize};

/// A single audit-log entry stored in the `"audit"` index.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub commit_seq: u64,
    pub event_type: String,
    pub stream_id: String,
    pub payload: serde_json::Value,
}

/// A user's *current* role within a workspace, maintained in the
/// `"rbac_roles"` index for O(1) authorization lookups. The audit log
/// remains the durable history; this is the live projection of it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CurrentRole {
    pub workspace_id: String,
    pub user_id: u64,
    pub role: String,
}

fn encode_audit_key(commit_seq: u64) -> Vec<u8> {
    commit_seq.to_be_bytes().to_vec()
}

fn decode_audit_entry(event: &DurableEvent) -> Result<AuditEntry> {
    let payload: serde_json::Value = serde_json::from_slice(&event.payload)
        .map_err(|_| crate::error::WabiError::Validation {
            command: "audit_projection".into(),
            reason: "payload is not valid JSON".into(),
        })?;
    Ok(AuditEntry {
        commit_seq: event.commit_seq,
        event_type: event.event_type.clone(),
        stream_id: event.stream_id.clone(),
        payload,
    })
}

pub struct AuditProjection;

impl Projection for AuditProjection {
    fn event_type(&self) -> &str {
        "role_assigned"
    }

    fn event_types(&self) -> Vec<&str> {
        vec![
            "role_assigned",
            "role_removed",
            "channel_settings_updated",
        ]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let entry = decode_audit_entry(event)?;
        let value = serde_json::to_vec(&entry).map_err(|_| crate::error::WabiError::Validation {
            command: "audit_projection".into(),
            reason: "failed to serialize audit entry".into(),
        })?;
        let key = encode_audit_key(event.commit_seq);
        state.insert("audit_log", key, value, event.commit_seq);

        // Maintain the live `rbac_roles` index for authorization lookups.
        if event.event_type == "role_assigned" || event.event_type == "role_removed" {
            if let Ok(p) = serde_json::from_slice::<serde_json::Value>(&event.payload) {
                let uid = p.get("user_id").and_then(|v| v.as_u64()).unwrap_or(0);
                let ws = p
                    .get("workspace_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("default-workspace")
                    .to_string();
                let role = if event.event_type == "role_removed" {
                    // Single-role model: removing a role reverts to Member.
                    "Member".to_string()
                } else {
                    p.get("role")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Member")
                        .to_string()
                };
                let rbac_key = encode_rbac_key(&ws, uid);
                let cur = CurrentRole {
                    workspace_id: ws,
                    user_id: uid,
                    role,
                };
                if let Ok(bytes) = serde_json::to_vec(&cur) {
                    state.insert("rbac_roles", rbac_key, bytes, event.commit_seq);
                }
            }
        }
        Ok(())
    }
}

fn encode_rbac_key(workspace_id: &str, user_id: u64) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&(workspace_id.len() as u64).to_le_bytes());
    buf.extend_from_slice(workspace_id.as_bytes());
    buf.extend_from_slice(&user_id.to_le_bytes());
    buf
}

impl AuditProjection {
    /// Count recorded role/channel-setting events without decoding their payloads.
    pub fn count(state: &ProjectionState) -> usize {
        state.index_len("audit_log")
    }

    /// Read the newest recorded entries in commit order, visiting at most `limit`
    /// records. Keys are fixed-width big-endian sequences, not textual IDs.
    /// Historical entries do not record timestamps; never derive time from seq.
    pub fn recent(state: &ProjectionState, limit: usize) -> Result<Vec<AuditEntry>> {
        let mut entries = Vec::new();
        if limit == 0 {
            return Ok(entries);
        }
        let mut failure = None;
        state.prefix_scan_reverse("audit_log", &[], |key, value| {
            match serde_json::from_slice::<AuditEntry>(value) {
                Ok(entry) if key == entry.commit_seq.to_be_bytes() => entries.push(entry),
                _ => {
                    failure = Some(crate::error::WabiError::Corrupt {
                        location: "audit_log".into(),
                        detail: "invalid audit entry or commit sequence key".into(),
                    });
                    return false;
                }
            }
            entries.len() < limit
        });
        if let Some(error) = failure {
            return Err(error);
        }
        Ok(entries)
    }

    /// Lookup a user's current role within a workspace, if any.
    pub fn get_role(state: &ProjectionState, workspace_id: &str, user_id: u64) -> Option<String> {
        let key = encode_rbac_key(workspace_id, user_id);
        state.get("rbac_roles", &key).and_then(|bytes| {
            serde_json::from_slice::<CurrentRole>(&bytes)
                .ok()
                .map(|r| r.role)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::locks::ProjectionState;

    fn make_event(seq: u64, event_type: &str, stream_id: &str, payload: serde_json::Value) -> DurableEvent {
        DurableEvent {
            commit_seq: seq,
            event_type: event_type.into(),
            stream_id: stream_id.into(),
            payload: serde_json::to_vec(&payload).unwrap(),
        }
    }

    #[test]
    fn recent_is_bounded_and_orders_numeric_sequences_without_a_full_scan() {
        let state = ProjectionState::new();
        assert_eq!(AuditProjection::count(&state), 0);
        assert!(AuditProjection::recent(&state, 10).unwrap().is_empty());
        for seq in [1, 7, 8, 9, 15, 16, 17, 255, 256, 257, 4095, 4096] {
            AuditProjection.apply(&make_event(seq, "role_assigned", "rbac:default",
                serde_json::json!({"user_id":42,"role":"Member"})), &state).unwrap();
        }
        assert_eq!(AuditProjection::count(&state), 12);
        // An older malformed row outside the selected tail must not be decoded.
        // This proves the query is bounded, not a full decode/sort/truncate pass.
        state.insert("audit_log", encode_audit_key(1), b"corrupt old row".to_vec(), 1);
        let entries = AuditProjection::recent(&state, 10).unwrap();
        assert_eq!(entries.iter().map(|entry| entry.commit_seq).collect::<Vec<_>>(),
            vec![4096, 4095, 257, 256, 255, 17, 16, 15, 9, 8]);
        assert!(AuditProjection::recent(&state, 0).unwrap().is_empty());
        assert!(AuditProjection::recent(&state, 12).is_err());
        assert_eq!(AuditProjection::count(&state), 12);
    }

    #[test]
    fn recent_rejects_corrupt_or_mismatched_sequence_rows() {
        for (key, value) in [
            (encode_audit_key(1), b"not JSON".to_vec()),
            (encode_audit_key(2), serde_json::to_vec(&AuditEntry { commit_seq: 1,
                event_type:"role_assigned".into(), stream_id:"rbac:default".into(),
                payload:serde_json::json!({}) }).unwrap()),
        ] {
            let state = ProjectionState::new();
            state.insert("audit_log", key, value, 2);
            assert!(matches!(AuditProjection::recent(&state, 10), Err(crate::error::WabiError::Corrupt { .. })));
        }
    }

    #[test]
    fn stores_role_assigned() {
        let state = ProjectionState::new();
        let proj = AuditProjection;
        let payload = serde_json::json!({
            "user_id": 42,
            "workspace_id": "default",
            "role": "Admin",
            "assigned_by": 1,
        });
        let event = make_event(1, "role_assigned", "rbac:default", payload);
        proj.apply(&event, &state).unwrap();

        let key = encode_audit_key(1);
        let stored = state.get("audit_log", &key).unwrap();
        let entry: AuditEntry = serde_json::from_slice(&stored).unwrap();
        assert_eq!(entry.commit_seq, 1);
        assert_eq!(entry.event_type, "role_assigned");
    }

    #[test]
    fn stores_multiple_event_types() {
        let proj = AuditProjection;
        assert!(proj.event_types().contains(&"role_assigned"));
        assert!(proj.event_types().contains(&"role_removed"));
        assert!(proj.event_types().contains(&"channel_settings_updated"));
    }

    #[test]
    fn bad_payload_returns_error() {
        let state = ProjectionState::new();
        let event = DurableEvent {
            commit_seq: 1,
            event_type: "role_assigned".into(),
            stream_id: "rbac".into(),
            payload: vec![0xde, 0xad],
        };
        let result = AuditProjection.apply(&event, &state);
        assert!(result.is_err());
    }
}
