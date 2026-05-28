//! Snapshot table policy.
//!
//! This is intentionally allowlist-based. Anything not listed here is not part
//! of the initial standby live-state snapshot surface.

/// Tables that are current/live state and are candidates for a full restore snapshot.
///
/// This allowlist is intentionally conservative. Transient tables, socket leases,
/// call signaling, and historical ingest/event tables are excluded by default.
pub const LIVE_STATE_SNAPSHOT_TABLES: &[&str] = &[
    "state_album",
    "state_album_item",
    "state_app_setting",
    "state_ban",
    "state_channel",
    "state_channel_member",
    "state_deafen",
    "state_dictionary_entry",
    "state_emoji_role_rule",
    "state_emote",
    "state_guest_code",
    "state_layout_preferences",
    "state_message",
    "state_mute",
    "state_payment_account_link",
    "state_payment_intent",
    "state_payment_policy",
    "state_payment_user_block",
    "state_rbac_assignment",
    "state_reaction",
    "state_role_definition",
    "state_theme_preferences",
    "state_user",
    "state_user_encryption_key",
    "state_user_handle",
    "state_user_meta",
    "state_user_settings",
    "state_user_username",
    "state_webhook",
    "state_webhook_delivery",
    "state_whiteboard",
];

/// Tables excluded from standby snapshots because they are transient, historical,
/// or unsafe for deletion-respecting backup semantics.
pub const EXCLUDED_SNAPSHOT_TABLES: &[&str] = &[
    "ingested_event",
    "state_backend_instance_lease",
    "state_call_participant",
    "state_call_session",
    "state_call_signal",
    "state_manual_settlement",
    "state_offline_message",
    "state_payment_event",
    "state_presence_lease",
    "state_relay",
    "state_session",
    "state_socket_lease",
];

pub fn is_live_state_snapshot_table(table: &str) -> bool {
    LIVE_STATE_SNAPSHOT_TABLES
        .iter()
        .any(|candidate| candidate == &table)
}

pub fn is_excluded_snapshot_table(table: &str) -> bool {
    EXCLUDED_SNAPSHOT_TABLES
        .iter()
        .any(|candidate| candidate == &table)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_table_policy_is_allowlist_based() {
        assert!(is_live_state_snapshot_table("state_message"));
        assert!(is_live_state_snapshot_table("state_user_encryption_key"));
        assert!(!is_live_state_snapshot_table("state_presence_lease"));
        assert!(is_excluded_snapshot_table("state_presence_lease"));
        assert!(is_excluded_snapshot_table("ingested_event"));
    }
}
