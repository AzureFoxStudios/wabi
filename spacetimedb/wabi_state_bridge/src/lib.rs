use serde::Deserialize;
use serde_json::{json, Map, Value};
use spacetimedb::{ReducerContext, Table, Timestamp};

const MAX_EVENT_JSON_BYTES: usize = 512 * 1024;
const MAX_EVENT_ID_BYTES: usize = 160;
const MAX_ENTITY_BYTES: usize = 64;
const MAX_OPERATION_BYTES: usize = 64;
const MAX_PAYLOAD_JSON_BYTES: usize = 384 * 1024;

/// Pre-shared ingest key table. The backend must call `set_ingest_key` once
/// to register a key, and all subsequent `ingest_wabi_event` calls must
/// include a matching `authKey` field.  This prevents unauthorized reducer
/// calls even if a SpaceTimeDB connection token is compromised.
#[spacetimedb::table(accessor = ingest_auth_config)]
pub struct IngestAuthConfig {
    #[primary_key]
    pub config_key: String,
    pub auth_key_hash: String,
    pub updated_at: Timestamp,
}

/// One-time setup reducer to register the ingest auth key.
/// Call with the SHA-256 hex digest of the secret.  Subsequent calls
/// update the key (requires the previous key for rotation).
#[spacetimedb::reducer]
pub fn set_ingest_key(
    ctx: &ReducerContext,
    key_sha256_hex: String,
    previous_key_sha256_hex: Option<String>,
) -> Result<(), String> {
    let trimmed = key_sha256_hex.trim().to_lowercase();
    if trimmed.len() != 64 || !trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("key_sha256_hex must be a 64-char hex SHA-256 digest".into());
    }
    let existing = ctx.db.ingest_auth_config().config_key().find(&"default".to_string());
    if let Some(ref row) = existing {
        // Rotation: must provide previous key
        match previous_key_sha256_hex {
            Some(ref prev) if prev.trim().to_lowercase() == row.auth_key_hash => {}
            _ => return Err("previous_key_sha256_hex required for key rotation".into()),
        }
    }
    if let Some(old) = existing {
        ctx.db.ingest_auth_config().config_key().delete(&old.config_key);
    }
    ctx.db.ingest_auth_config().insert(IngestAuthConfig {
        config_key: "default".into(),
        auth_key_hash: trimmed,
        updated_at: ctx.timestamp,
    });
    Ok(())
}

fn verify_ingest_auth(ctx: &ReducerContext, provided_key: &str) -> Result<(), String> {
    let config = ctx.db.ingest_auth_config().config_key().find(&"default".to_string());
    match config {
        None => {
            // No key configured yet — allow (first-run bootstrap)
            Ok(())
        }
        Some(row) => {
            // Compare SHA-256 hex of provided key against stored hash
            use std::collections::hash_map::DefaultHasher;
            use std::hash::{Hash, Hasher};
            // Simple constant-time-ish comparison of hex digests
            let provided_trimmed = provided_key.trim().to_lowercase();
            if provided_trimmed == row.auth_key_hash {
                Ok(())
            } else {
                Err("ingest_auth_failed: invalid authKey".into())
            }
        }
    }
}

#[spacetimedb::table(accessor = ingested_event)]
#[derive(Clone)]
pub struct IngestedEvent {
    #[primary_key]
    pub event_id: String,
    pub event_timestamp: i64,
    pub entity: String,
    pub operation: String,
    pub payload_json: String,
    pub ingested_at: Timestamp,
}

#[spacetimedb::table(accessor = state_message)]
#[derive(Clone)]
pub struct StateMessage {
    #[primary_key]
    pub message_id: String,
    pub channel_id: String,
    pub sender_id: String,
    pub created_at: i64,
    pub deleted: bool,
    pub deleted_at: Option<i64>,
    pub row_json: String,
    pub last_updated_at: Timestamp,
}

#[spacetimedb::table(accessor = state_channel)]
#[derive(Clone)]
pub struct StateChannel {
    #[primary_key]
    pub channel_id: String,
    pub channel_type: String,
    pub name: String,
    pub created_at: i64,
    pub created_by: String,
    pub archived: bool,
    pub row_json: String,
    pub last_updated_at: Timestamp,
}

#[spacetimedb::table(accessor = state_channel_member)]
#[derive(Clone)]
pub struct StateChannelMember {
    #[primary_key]
    pub member_key: String,
    pub channel_id: String,
    pub user_id: String,
    pub role: String,
    pub joined_at: i64,
    pub active: bool,
    pub row_json: String,
    pub last_updated_at: Timestamp,
}

#[spacetimedb::table(accessor = state_user)]
#[derive(Clone)]
pub struct StateUser {
    #[primary_key]
    pub user_id: i64,
    pub username: Option<String>,
    pub username_lc: Option<String>,
    pub handle: Option<String>,
    pub handle_lc: Option<String>,
    pub active: bool,
    pub deleted: bool,
    pub row_json: String,
    pub last_updated_at: Timestamp,
}

#[spacetimedb::table(accessor = state_user_meta)]
#[derive(Clone)]
pub struct StateUserMeta {
    #[primary_key]
    pub meta_key: String,
    pub next_user_id: i64,
    pub last_updated_at: Timestamp,
}

#[spacetimedb::table(accessor = state_user_username)]
#[derive(Clone)]
pub struct StateUserUsername {
    #[primary_key]
    pub username_lc: String,
    pub user_id: i64,
    pub last_updated_at: Timestamp,
}

#[spacetimedb::table(accessor = state_user_handle)]
#[derive(Clone)]
pub struct StateUserHandle {
    #[primary_key]
    pub handle_lc: String,
    pub user_id: i64,
    pub last_updated_at: Timestamp,
}

#[spacetimedb::table(accessor = state_session)]
#[derive(Clone)]
pub struct StateSession {
    #[primary_key]
    pub session_id: String,
    pub user_id: Option<i64>,
    pub expires_at: Option<i64>,
    pub is_temporary: bool,
    pub deleted: bool,
    pub row_json: String,
    pub last_updated_at: Timestamp,
}

#[spacetimedb::table(accessor = state_rbac_assignment)]
#[derive(Clone)]
pub struct StateRbacAssignment {
    #[primary_key]
    pub assignment_key: String,
    pub workspace_id: String,
    pub user_id: i64,
    pub role: String,
    pub assigned_by: Option<i64>,
    pub active: bool,
    pub row_json: String,
    pub last_updated_at: Timestamp,
}

#[spacetimedb::table(accessor = state_role_definition)]
#[derive(Clone)]
pub struct StateRoleDefinition {
    #[primary_key]
    pub role_key: String,
    pub workspace_id: String,
    pub role_name: String,
    pub display_name: String,
    pub priority: i64,
    pub color: Option<String>,
    pub is_hoisted: bool,
    pub active: bool,
    pub row_json: String,
    pub last_updated_at: Timestamp,
}

#[spacetimedb::table(accessor = state_user_settings)]
#[derive(Clone)]
pub struct StateUserSettings {
    #[primary_key]
    pub user_id: i64,
    pub offline_message_retention: String,
    pub allow_temp_user_messages: bool,
    pub business_private_mode: bool,
    pub home_experience: String,
    pub require_password_change: bool,
    pub payment_preferred_route: Option<String>,
    pub row_json: String,
    pub last_updated_at: Timestamp,
}

#[spacetimedb::table(accessor = state_theme_preferences)]
#[derive(Clone)]
pub struct StateThemePreferences {
    #[primary_key]
    pub user_id: i64,
    pub theme_id: String,
    pub custom_theme: Option<String>,
    pub uniform_font_enabled: bool,
    pub uniform_font_family: String,
    pub uniform_font_size: String,
    pub uniform_font_weight: String,
    pub uniform_font_style: String,
    pub row_json: String,
    pub last_updated_at: Timestamp,
}

#[spacetimedb::table(accessor = state_relay)]
#[derive(Clone)]
pub struct StateRelay {
    #[primary_key]
    pub relay_id: i64,
    pub url: String,
    pub name: String,
    pub region: String,
    pub api_key_hash: String,
    pub status: String,
    pub last_health_ping: Option<i64>,
    pub registered_at: i64,
    pub approved: bool,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub bandwidth_mbps: Option<i64>,
    pub storage_gb: Option<i64>,
    pub syncthing_device_id: Option<String>,
    pub metadata_json: Option<String>,
    pub row_json: String,
    pub last_updated_at: Timestamp,
}

#[spacetimedb::table(accessor = state_dictionary_entry)]
#[derive(Clone)]
pub struct StateDictionaryEntry {
    #[primary_key]
    pub entry_key: String,
    pub workspace_id: String,
    pub language: String,
    pub term_normalized: String,
    pub term: String,
    pub created_by_user_id: Option<i64>,
    pub created_by_username: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub votes: i64,
    pub row_json: String,
    pub last_updated_at: Timestamp,
}

#[spacetimedb::table(accessor = state_app_setting)]
#[derive(Clone)]
pub struct StateAppSetting {
    #[primary_key]
    pub setting_key: String,
    pub value: String,
    pub updated_at: i64,
    pub row_json: String,
    pub last_updated_at: Timestamp,
}

#[spacetimedb::table(accessor = state_backend_instance_lease)]
#[derive(Clone)]
pub struct StateBackendInstanceLease {
    #[primary_key]
    pub instance_id: String,
    pub region: String,
    pub role: String,
    pub status: String,
    pub current_connections: i64,
    pub current_registered_users: i64,
    pub current_guest_users: i64,
    pub heartbeat_at: i64,
    pub lease_expires_at: i64,
    pub started_at: i64,
    pub row_json: String,
    pub last_updated_at: Timestamp,
}

#[spacetimedb::table(accessor = state_socket_lease)]
#[derive(Clone)]
pub struct StateSocketLease {
    #[primary_key]
    pub stable_user_id: String,
    pub db_user_id: Option<i64>,
    pub instance_id: String,
    pub status: String,
    pub connected_at: i64,
    pub lease_expires_at: i64,
    pub row_json: String,
    pub last_updated_at: Timestamp,
}

#[spacetimedb::table(accessor = state_presence_lease)]
#[derive(Clone)]
pub struct StatePresenceLease {
    #[primary_key]
    pub stable_user_id: String,
    pub db_user_id: Option<i64>,
    pub instance_id: String,
    pub username: Option<String>,
    pub color: Option<String>,
    pub profile_picture: Option<String>,
    pub status: String,
    pub connected_at: i64,
    pub lease_expires_at: i64,
    pub row_json: String,
    pub last_updated_at: Timestamp,
}

#[spacetimedb::table(accessor = state_payment_intent)]
#[derive(Clone)]
pub struct StatePaymentIntent {
    #[primary_key]
    pub intent_id: String,
    pub workspace_id: String,
    pub created_by_user_id: Option<i64>,
    pub channel_id: Option<String>,
    pub plugin_id: String,
    pub provider_name: String,
    pub provider_intent_id: Option<String>,
    pub amount_minor: i64,
    pub currency: String,
    pub country_code: Option<String>,
    pub status: String,
    pub checkout_mode: String,
    pub idempotency_key: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub row_json: String,
    pub last_updated_at: Timestamp,
}

#[spacetimedb::table(accessor = state_payment_event)]
#[derive(Clone)]
pub struct StatePaymentEvent {
    #[primary_key]
    pub event_id: String,
    pub intent_id: String,
    pub event_type: String,
    pub status: Option<String>,
    pub source: String,
    pub idempotency_key: Option<String>,
    pub created_at: i64,
    pub row_json: String,
    pub last_updated_at: Timestamp,
}

#[spacetimedb::table(accessor = state_manual_settlement)]
#[derive(Clone)]
pub struct StateManualSettlement {
    #[primary_key]
    pub settlement_id: String,
    pub workspace_id: String,
    pub settlement_kind: String,
    pub channel_id: Option<String>,
    pub created_by_user_id: i64,
    pub counterparty_user_id: Option<i64>,
    pub status: String,
    pub currency: String,
    pub amount_minor: i64,
    pub completed_at: Option<i64>,
    pub voided_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub row_json: String,
    pub last_updated_at: Timestamp,
}

#[spacetimedb::table(accessor = state_payment_account_link)]
#[derive(Clone)]
pub struct StatePaymentAccountLink {
    #[primary_key]
    pub account_link_key: String,
    pub user_id: i64,
    pub workspace_id: String,
    pub plugin_id: String,
    pub updated_at: i64,
    pub row_json: String,
    pub last_updated_at: Timestamp,
}

#[spacetimedb::table(accessor = state_payment_user_block)]
#[derive(Clone)]
pub struct StatePaymentUserBlock {
    #[primary_key]
    pub block_key: String,
    pub user_id: i64,
    pub workspace_id: String,
    pub blocked_by_user_id: Option<i64>,
    pub blocked_at: i64,
    pub expires_at: Option<i64>,
    pub row_json: String,
    pub last_updated_at: Timestamp,
}

#[spacetimedb::table(accessor = state_payment_policy)]
#[derive(Clone)]
pub struct StatePaymentPolicy {
    #[primary_key]
    pub policy_key: String,
    pub updated_at: i64,
    pub row_json: String,
    pub last_updated_at: Timestamp,
}

#[spacetimedb::table(accessor = state_user_encryption_key)]
#[derive(Clone)]
pub struct StateUserEncryptionKey {
    #[primary_key]
    pub user_id: i64,
    pub public_key: String,
    pub private_key_encrypted: String,
    pub created_at: i64,
    pub row_json: String,
    pub last_updated_at: Timestamp,
}

#[derive(Deserialize, Clone)]
struct IngestEnvelope {
    #[serde(rename = "eventId", default)]
    event_id: Option<String>,
    #[serde(default)]
    timestamp: Option<i64>,
    entity: String,
    operation: String,
    #[serde(default)]
    payload: Value,
    /// SHA-256 hex digest of the pre-shared ingest secret.
    /// Must match the value registered via `set_ingest_key`.
    #[serde(rename = "authKey", default)]
    auth_key: Option<String>,
}

fn supported_entity(entity: &str) -> bool {
    matches!(
        entity,
        "message"
            | "channel"
            | "channel_member"
            | "user"
            | "session"
            | "rbac"
            | "settings"
            | "theme"
            | "payment"
            | "encryption_key"
            | "relay"
            | "dictionary"
            | "app_setting"
            | "mesh"
            | "presence"
            | "system"
    )
}

#[spacetimedb::reducer]
pub fn ingest_wabi_event(ctx: &ReducerContext, event_json: String) -> Result<(), String> {
    if event_json.as_bytes().len() > MAX_EVENT_JSON_BYTES {
        return Err(format!(
            "event_json_too_large: max={} bytes",
            MAX_EVENT_JSON_BYTES
        ));
    }

    let mut event: IngestEnvelope =
        serde_json::from_str(&event_json).map_err(|e| format!("invalid_event_json: {e}"))?;

    // Verify ingest auth key before processing any event
    verify_ingest_auth(ctx, event.auth_key.as_deref().unwrap_or(""))?;

    event.entity = event.entity.trim().to_lowercase();
    event.operation = event.operation.trim().to_string();
    if event.entity.is_empty() {
        return Err("event.entity is required".to_string());
    }
    if event.operation.is_empty() {
        return Err("event.operation is required".to_string());
    }
    if !supported_entity(&event.entity) {
        return Err(format!("unsupported event.entity '{}'", event.entity));
    }
    if event.entity.as_bytes().len() > MAX_ENTITY_BYTES {
        return Err(format!("event.entity too long (max {} bytes)", MAX_ENTITY_BYTES));
    }
    if event.operation.as_bytes().len() > MAX_OPERATION_BYTES {
        return Err(format!(
            "event.operation too long (max {} bytes)",
            MAX_OPERATION_BYTES
        ));
    }

    let event_id = ensure_event_id(ctx, event.event_id.as_deref(), &event.entity, &event.operation)?;
    if event_id.as_bytes().len() > MAX_EVENT_ID_BYTES {
        return Err(format!(
            "event.eventId too long (max {} bytes)",
            MAX_EVENT_ID_BYTES
        ));
    }

    // Idempotent ingress: duplicate event IDs are accepted as no-op.
    if ctx.db.ingested_event().event_id().find(&event_id).is_some() {
        return Ok(());
    }

    let payload_json = serde_json::to_string(&event.payload).unwrap_or_else(|_| "{}".to_string());
    if payload_json.as_bytes().len() > MAX_PAYLOAD_JSON_BYTES {
        return Err(format!(
            "event.payload too large (max {} bytes)",
            MAX_PAYLOAD_JSON_BYTES
        ));
    }
    ctx.db.ingested_event().insert(IngestedEvent {
        event_id: event_id.clone(),
        event_timestamp: event.timestamp.unwrap_or(0),
        entity: event.entity.clone(),
        operation: event.operation.clone(),
        payload_json,
        ingested_at: ctx.timestamp,
    });

    apply_projection(ctx, &event.entity, &event.operation, &event.payload);
    Ok(())
}

fn ensure_event_id(
    ctx: &ReducerContext,
    candidate: Option<&str>,
    entity: &str,
    operation: &str,
) -> Result<String, String> {
    if let Some(raw) = candidate {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    if let Ok(uuid) = ctx.new_uuid_v7() {
        return Ok(format!("auto:{uuid}"));
    }
    if let Ok(uuid) = ctx.new_uuid_v4() {
        return Ok(format!("auto:{uuid}"));
    }
    Err(format!(
        "missing_event_id and uuid generation failed for {entity}.{operation}"
    ))
}

fn apply_projection(ctx: &ReducerContext, entity: &str, operation: &str, payload: &Value) {
    match (entity, operation) {
        ("message", "create")
        | ("message", "update")
        | ("message", "updateReactions")
        | ("message", "markEdited") => apply_message_upsert(ctx, payload, None),
        ("message", "softDelete") => apply_message_upsert(ctx, payload, Some(true)),
        ("message", "purgeDeleted") => apply_message_purge_deleted(ctx, payload),
        ("message", "clearAll") => apply_message_clear_all(ctx),
        ("message", _) => apply_message_touch(ctx, payload),

        ("channel", "create")
        | ("channel", "update_settings")
        | ("channel", "update_avatar") => apply_channel_upsert(ctx, payload, None),
        ("channel", "archive") => apply_channel_upsert(ctx, payload, Some(true)),
        ("channel", "delete") => apply_channel_delete(ctx, payload),
        ("channel", _) => apply_channel_touch(ctx, payload),

        ("channel_member", "add_member") | ("channel_member", "update_member") => {
            apply_channel_member_upsert(ctx, payload, None)
        }
        ("channel_member", "remove_member") => apply_channel_member_remove(ctx, payload),
        ("channel_member", _) => {}

        ("user", "create") | ("user", "update") => apply_user_upsert(ctx, payload, None),
        ("user", "delete") => apply_user_upsert(ctx, payload, Some(true)),
        ("user", _) => {}

        ("session", "create") | ("session", "update") => apply_session_upsert(ctx, payload, None),
        ("session", "delete") => apply_session_upsert(ctx, payload, Some(true)),
        ("session", "cleanup") => apply_session_cleanup(ctx, payload),
        ("session", _) => {}

        ("rbac", "assign_role") => apply_rbac_upsert(ctx, payload, true),
        ("rbac", "remove_role") => apply_rbac_upsert(ctx, payload, false),
        ("rbac", "upsert_role_definition") => apply_role_definition_upsert(ctx, payload, true),
        ("rbac", "delete_role_definition") => apply_role_definition_upsert(ctx, payload, false),
        ("rbac", _) => {}

        ("settings", "upsert_user_settings") => apply_user_settings_upsert(ctx, payload),
        ("settings", _) => {}

        ("theme", "upsert_theme_preferences") => apply_theme_preferences_upsert(ctx, payload),
        ("theme", _) => {}

        ("payment", "upsert_intent") => apply_payment_intent_upsert(ctx, payload),
        ("payment", "append_event") => apply_payment_event_upsert(ctx, payload),
        ("payment", "upsert_manual_settlement") => apply_manual_settlement_upsert(ctx, payload),
        ("payment", "upsert_account_link") => apply_payment_account_link_upsert(ctx, payload),
        ("payment", "delete_account_link") => apply_payment_account_link_delete(ctx, payload),
        ("payment", "upsert_user_block") => apply_payment_user_block_upsert(ctx, payload),
        ("payment", "delete_user_block") => apply_payment_user_block_delete(ctx, payload),
        ("payment", "upsert_policy") => apply_payment_policy_upsert(ctx, payload),
        ("payment", _) => {}

        ("encryption_key", "upsert_user_encryption_key") => apply_user_encryption_key_upsert(ctx, payload),
        ("encryption_key", _) => {}

        ("relay", "upsert_relay") => apply_relay_upsert(ctx, payload),
        ("relay", "delete_relay") => apply_relay_delete(ctx, payload),
        ("relay", _) => {}

        ("dictionary", "upsert_entry") => apply_dictionary_entry_upsert(ctx, payload),
        ("dictionary", "delete_entry") => apply_dictionary_entry_delete(ctx, payload),
        ("dictionary", _) => {}

        ("app_setting", "upsert_app_setting") => apply_app_setting_upsert(ctx, payload),
        ("app_setting", _) => {}

        ("mesh", "upsert_backend_instance_lease") => apply_backend_instance_lease_upsert(ctx, payload),
        ("mesh", "upsert_socket_lease") => apply_socket_lease_upsert(ctx, payload),
        ("mesh", "delete_socket_lease") => apply_socket_lease_delete(ctx, payload),
        ("mesh", _) => {}

        ("presence", "upsert_presence_lease") => apply_presence_lease_upsert(ctx, payload),
        ("presence", "delete_presence_lease") => apply_presence_lease_delete(ctx, payload),

        // presence/system keep only the ingested event log.
        _ => {}
    }
}

fn payload_obj(payload: &Value) -> Option<&Map<String, Value>> {
    payload.as_object()
}

fn payload_row_value(payload: &Value) -> Option<&Value> {
    payload_obj(payload).and_then(|obj| obj.get("row"))
}

fn payload_row_obj(payload: &Value) -> Option<&Map<String, Value>> {
    payload_row_value(payload).and_then(Value::as_object)
}

fn map_string(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key).and_then(Value::as_str).map(|s| s.to_string())
}

fn map_bool(map: &Map<String, Value>, key: &str) -> Option<bool> {
    map.get(key).and_then(value_to_bool)
}

fn map_i64(map: &Map<String, Value>, key: &str) -> Option<i64> {
    map.get(key).and_then(value_to_i64)
}

fn map_string_any(map: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| map_string(map, key))
}

fn map_i64_any(map: &Map<String, Value>, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|key| map_i64(map, key))
}

fn map_f64(map: &Map<String, Value>, key: &str) -> Option<f64> {
    map.get(key).and_then(value_to_f64)
}

fn payload_string(payload: &Value, key: &str) -> Option<String> {
    payload_obj(payload)
        .and_then(|obj| obj.get(key))
        .and_then(Value::as_str)
        .map(|s| s.to_string())
}

fn payload_i64(payload: &Value, key: &str) -> Option<i64> {
    payload_obj(payload)
        .and_then(|obj| obj.get(key))
        .and_then(value_to_i64)
}

fn payload_bool(payload: &Value, key: &str) -> Option<bool> {
    payload_obj(payload)
        .and_then(|obj| obj.get(key))
        .and_then(value_to_bool)
}

fn payload_array_strings(payload: &Value, key: &str) -> Vec<String> {
    payload_obj(payload)
        .and_then(|obj| obj.get(key))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default()
}

fn value_to_i64(value: &Value) -> Option<i64> {
    if let Some(n) = value.as_i64() {
        return Some(n);
    }
    if let Some(n) = value.as_u64() {
        return i64::try_from(n).ok();
    }
    if let Some(s) = value.as_str() {
        return s.parse::<i64>().ok();
    }
    None
}

fn value_to_f64(value: &Value) -> Option<f64> {
    if let Some(n) = value.as_f64() {
        return Some(n);
    }
    if let Some(n) = value.as_i64() {
        return Some(n as f64);
    }
    if let Some(n) = value.as_u64() {
        return Some(n as f64);
    }
    if let Some(s) = value.as_str() {
        return s.parse::<f64>().ok();
    }
    None
}

fn value_to_bool(value: &Value) -> Option<bool> {
    if let Some(b) = value.as_bool() {
        return Some(b);
    }
    if let Some(i) = value_to_i64(value) {
        return Some(i != 0);
    }
    if let Some(s) = value.as_str() {
        let normalized = s.trim().to_lowercase();
        if matches!(normalized.as_str(), "1" | "true" | "yes" | "on") {
            return Some(true);
        }
        if matches!(normalized.as_str(), "0" | "false" | "no" | "off") {
            return Some(false);
        }
    }
    None
}

fn row_json_or_default(payload: &Value, fallback: Option<&str>, default_json: &str) -> String {
    if let Some(row_value) = payload_row_value(payload) {
        if let Ok(encoded) = serde_json::to_string(row_value) {
            return encoded;
        }
    }
    fallback
        .map(|s| s.to_string())
        .unwrap_or_else(|| default_json.to_string())
}

fn normalize_handle_lc(input: Option<&str>) -> Option<String> {
    input.map(|raw| raw.trim().trim_start_matches('@').to_lowercase())
}

fn member_key(channel_id: &str, user_id: &str) -> String {
    format!("{channel_id}:{user_id}")
}

fn assignment_key(workspace_id: &str, user_id: i64, role: &str) -> String {
    format!("{workspace_id}:{user_id}:{role}")
}

fn role_key(workspace_id: &str, role_name: &str) -> String {
    format!("{workspace_id}:{role_name}")
}

fn payment_account_link_key(workspace_id: &str, user_id: i64, plugin_id: &str) -> String {
    format!("{workspace_id}:{user_id}:{plugin_id}")
}

fn payment_user_block_key(workspace_id: &str, user_id: i64) -> String {
    format!("{workspace_id}:{user_id}")
}

fn set_next_user_id(ctx: &ReducerContext, observed_user_id: i64) {
    let target_next_id = observed_user_id.saturating_add(1).max(1);
    let meta_key = "default".to_string();
    if let Some(existing) = ctx.db.state_user_meta().meta_key().find(&meta_key) {
        if existing.next_user_id >= target_next_id {
            return;
        }
        let mut row = existing.clone();
        row.next_user_id = target_next_id;
        row.last_updated_at = ctx.timestamp;
        ctx.db.state_user_meta().meta_key().update(row);
        return;
    }

    ctx.db.state_user_meta().insert(StateUserMeta {
        meta_key,
        next_user_id: target_next_id,
        last_updated_at: ctx.timestamp,
    });
}

fn remove_username_lookup(ctx: &ReducerContext, username_lc: Option<&str>) {
    let Some(key) = username_lc else {
        return;
    };
    let normalized = key.trim();
    if normalized.is_empty() {
        return;
    }
    let _ = ctx
        .db
        .state_user_username()
        .username_lc()
        .delete(&normalized.to_string());
}

fn remove_handle_lookup(ctx: &ReducerContext, handle_lc: Option<&str>) {
    let Some(key) = handle_lc else {
        return;
    };
    let normalized = key.trim();
    if normalized.is_empty() {
        return;
    }
    let _ = ctx
        .db
        .state_user_handle()
        .handle_lc()
        .delete(&normalized.to_string());
}

fn upsert_username_lookup(ctx: &ReducerContext, username_lc: Option<&str>, user_id: i64) {
    let Some(raw) = username_lc else {
        return;
    };
    let key = raw.trim();
    if key.is_empty() {
        return;
    }
    let lookup_key = key.to_string();
    let next = StateUserUsername {
        username_lc: lookup_key.clone(),
        user_id,
        last_updated_at: ctx.timestamp,
    };
    if ctx
        .db
        .state_user_username()
        .username_lc()
        .find(&lookup_key)
        .is_some()
    {
        ctx.db.state_user_username().username_lc().update(next);
    } else {
        ctx.db.state_user_username().insert(next);
    }
}

fn upsert_handle_lookup(ctx: &ReducerContext, handle_lc: Option<&str>, user_id: i64) {
    let Some(raw) = handle_lc else {
        return;
    };
    let key = raw.trim();
    if key.is_empty() {
        return;
    }
    let lookup_key = key.to_string();
    let next = StateUserHandle {
        handle_lc: lookup_key.clone(),
        user_id,
        last_updated_at: ctx.timestamp,
    };
    if ctx
        .db
        .state_user_handle()
        .handle_lc()
        .find(&lookup_key)
        .is_some()
    {
        ctx.db.state_user_handle().handle_lc().update(next);
    } else {
        ctx.db.state_user_handle().insert(next);
    }
}

fn apply_message_upsert(ctx: &ReducerContext, payload: &Value, deleted_override: Option<bool>) {
    let row = payload_row_obj(payload);
    let Some(message_id) = row
        .and_then(|r| map_string(r, "message_id"))
        .or_else(|| payload_string(payload, "messageId"))
    else {
        return;
    };

    let existing = ctx.db.state_message().message_id().find(&message_id);
    let channel_id = row
        .and_then(|r| map_string(r, "channel_id"))
        .or_else(|| payload_string(payload, "channelId"))
        .or_else(|| existing.as_ref().map(|r| r.channel_id.clone()))
        .unwrap_or_default();
    let sender_id = row
        .and_then(|r| map_string(r, "sender_id"))
        .or_else(|| payload_string(payload, "senderId"))
        .or_else(|| existing.as_ref().map(|r| r.sender_id.clone()))
        .unwrap_or_default();
    let created_at = row
        .and_then(|r| map_i64(r, "created_at"))
        .or_else(|| payload_i64(payload, "createdAt"))
        .or_else(|| existing.as_ref().map(|r| r.created_at))
        .unwrap_or(0);

    let mut deleted = existing.as_ref().map(|r| r.deleted).unwrap_or(false);
    let mut deleted_at = existing.as_ref().and_then(|r| r.deleted_at);

    if let Some(row_obj) = row {
        if let Some(value) = map_i64(row_obj, "deleted_at") {
            deleted = true;
            deleted_at = Some(value);
        } else if row_obj.get("deleted_at").is_some() {
            deleted_at = None;
        }
        if let Some(value) = map_bool(row_obj, "deleted") {
            deleted = value;
            if !value {
                deleted_at = None;
            }
        }
    }

    if let Some(value) = payload_i64(payload, "deletedAt") {
        deleted_at = Some(value);
        deleted = true;
    }
    if let Some(value) = deleted_override {
        deleted = value;
        if !value {
            deleted_at = None;
        }
    }

    let fallback_json = existing.as_ref().map(|r| r.row_json.as_str());
    let row_json = row_json_or_default(
        payload,
        fallback_json,
        &format!(r#"{{"message_id":"{}"}}"#, message_id),
    );

    let next = StateMessage {
        message_id: message_id.clone(),
        channel_id,
        sender_id,
        created_at,
        deleted,
        deleted_at,
        row_json,
        last_updated_at: ctx.timestamp,
    };

    if existing.is_some() {
        ctx.db.state_message().message_id().update(next);
    } else {
        ctx.db.state_message().insert(next);
    }
}

fn apply_message_purge_deleted(ctx: &ReducerContext, payload: &Value) {
    for message_id in payload_array_strings(payload, "messageIds") {
        let _ = ctx.db.state_message().message_id().delete(&message_id);
    }
}

fn apply_message_clear_all(ctx: &ReducerContext) {
    let ids: Vec<String> = ctx
        .db
        .state_message()
        .iter()
        .map(|row| row.message_id)
        .collect();
    for message_id in ids {
        let _ = ctx.db.state_message().message_id().delete(&message_id);
    }
}

fn apply_message_touch(ctx: &ReducerContext, payload: &Value) {
    let Some(message_id) = payload_string(payload, "messageId") else {
        return;
    };
    if let Some(existing) = ctx.db.state_message().message_id().find(&message_id) {
        let mut row = existing.clone();
        row.last_updated_at = ctx.timestamp;
        ctx.db.state_message().message_id().update(row);
    }
}

fn apply_channel_upsert(ctx: &ReducerContext, payload: &Value, archived_override: Option<bool>) {
    let row = payload_row_obj(payload);
    let Some(channel_id) = row
        .and_then(|r| map_string(r, "channel_id"))
        .or_else(|| payload_string(payload, "channelId"))
    else {
        return;
    };

    let existing = ctx.db.state_channel().channel_id().find(&channel_id);
    let channel_type = row
        .and_then(|r| map_string(r, "channel_type"))
        .or_else(|| payload_string(payload, "channelType"))
        .or_else(|| existing.as_ref().map(|r| r.channel_type.clone()))
        .unwrap_or_else(|| "unknown".to_string());
    let name = row
        .and_then(|r| map_string(r, "name"))
        .or_else(|| existing.as_ref().map(|r| r.name.clone()))
        .unwrap_or_default();
    let created_at = row
        .and_then(|r| map_i64(r, "created_at"))
        .or_else(|| existing.as_ref().map(|r| r.created_at))
        .unwrap_or(0);
    let created_by = row
        .and_then(|r| map_string(r, "created_by"))
        .or_else(|| existing.as_ref().map(|r| r.created_by.clone()))
        .unwrap_or_default();

    let mut archived = existing.as_ref().map(|r| r.archived).unwrap_or(false);
    if let Some(value) = row.and_then(|r| map_bool(r, "is_archived")) {
        archived = value;
    }
    if let Some(value) = row.and_then(|r| map_bool(r, "archived")) {
        archived = value;
    }
    if let Some(value) = archived_override {
        archived = value;
    }

    let fallback_json = existing.as_ref().map(|r| r.row_json.as_str());
    let row_json = row_json_or_default(
        payload,
        fallback_json,
        &format!(r#"{{"channel_id":"{}"}}"#, channel_id),
    );

    let next = StateChannel {
        channel_id: channel_id.clone(),
        channel_type,
        name,
        created_at,
        created_by,
        archived,
        row_json,
        last_updated_at: ctx.timestamp,
    };

    if existing.is_some() {
        ctx.db.state_channel().channel_id().update(next);
    } else {
        ctx.db.state_channel().insert(next);
    }
}

fn apply_channel_delete(ctx: &ReducerContext, payload: &Value) {
    let Some(channel_id) = payload_string(payload, "channelId") else {
        return;
    };

    let member_keys: Vec<String> = ctx
        .db
        .state_channel_member()
        .iter()
        .filter(|row| row.channel_id == channel_id)
        .map(|row| row.member_key)
        .collect();
    for key in member_keys {
        let _ = ctx.db.state_channel_member().member_key().delete(&key);
    }

    let message_ids: Vec<String> = ctx
        .db
        .state_message()
        .iter()
        .filter(|row| row.channel_id == channel_id)
        .map(|row| row.message_id)
        .collect();
    for message_id in message_ids {
        let _ = ctx.db.state_message().message_id().delete(&message_id);
    }

    let _ = ctx.db.state_channel().channel_id().delete(&channel_id);
}

fn apply_channel_touch(ctx: &ReducerContext, payload: &Value) {
    let Some(channel_id) = payload_string(payload, "channelId") else {
        return;
    };
    if let Some(existing) = ctx.db.state_channel().channel_id().find(&channel_id) {
        let mut row = existing.clone();
        row.last_updated_at = ctx.timestamp;
        ctx.db.state_channel().channel_id().update(row);
    }
}

fn apply_channel_member_upsert(
    ctx: &ReducerContext,
    payload: &Value,
    active_override: Option<bool>,
) {
    let row = payload_row_obj(payload);
    let channel_id = row
        .and_then(|r| map_string(r, "channel_id"))
        .or_else(|| payload_string(payload, "channelId"))
        .unwrap_or_default();
    let user_id = row
        .and_then(|r| map_string(r, "user_id"))
        .or_else(|| payload_string(payload, "userId"))
        .unwrap_or_default();
    if channel_id.is_empty() || user_id.is_empty() {
        return;
    }

    let key = member_key(&channel_id, &user_id);
    let existing = ctx.db.state_channel_member().member_key().find(&key);

    let role = row
        .and_then(|r| map_string(r, "role"))
        .or_else(|| payload_string(payload, "role"))
        .or_else(|| existing.as_ref().map(|r| r.role.clone()))
        .unwrap_or_else(|| "member".to_string());
    let joined_at = row
        .and_then(|r| map_i64(r, "joined_at"))
        .or_else(|| existing.as_ref().map(|r| r.joined_at))
        .unwrap_or(0);
    let mut active = existing.as_ref().map(|r| r.active).unwrap_or(true);
    if let Some(value) = row.and_then(|r| map_bool(r, "active")) {
        active = value;
    }
    if let Some(value) = active_override {
        active = value;
    }

    let fallback_json = existing.as_ref().map(|r| r.row_json.as_str());
    let row_json = row_json_or_default(
        payload,
        fallback_json,
        &format!(
            r#"{{"channel_id":"{}","user_id":"{}","role":"{}"}}"#,
            channel_id, user_id, role
        ),
    );

    let next = StateChannelMember {
        member_key: key.clone(),
        channel_id,
        user_id,
        role,
        joined_at,
        active,
        row_json,
        last_updated_at: ctx.timestamp,
    };

    if existing.is_some() {
        ctx.db.state_channel_member().member_key().update(next);
    } else {
        ctx.db.state_channel_member().insert(next);
    }
}

fn apply_channel_member_remove(ctx: &ReducerContext, payload: &Value) {
    let channel_id = payload_string(payload, "channelId").unwrap_or_default();
    let user_id = payload_string(payload, "userId").unwrap_or_default();
    if channel_id.is_empty() || user_id.is_empty() {
        return;
    }
    let key = member_key(&channel_id, &user_id);
    if let Some(existing) = ctx.db.state_channel_member().member_key().find(&key) {
        let mut row = existing.clone();
        row.active = false;
        row.last_updated_at = ctx.timestamp;
        ctx.db.state_channel_member().member_key().update(row);
    }
}

fn apply_user_upsert(ctx: &ReducerContext, payload: &Value, deleted_override: Option<bool>) {
    let row = payload_row_obj(payload);
    let Some(user_id) = row
        .and_then(|r| map_i64(r, "user_id"))
        .or_else(|| payload_i64(payload, "userId"))
    else {
        return;
    };

    let existing = ctx.db.state_user().user_id().find(&user_id);
    let previous_username_lc = existing.as_ref().and_then(|r| r.username_lc.clone());
    let previous_handle_lc = existing.as_ref().and_then(|r| r.handle_lc.clone());

    let username = row
        .and_then(|r| map_string(r, "username"))
        .or_else(|| payload_string(payload, "username"))
        .or_else(|| existing.as_ref().and_then(|r| r.username.clone()));
    let handle = row
        .and_then(|r| map_string(r, "handle"))
        .or_else(|| payload_string(payload, "handle"))
        .or_else(|| existing.as_ref().and_then(|r| r.handle.clone()));
    let mut active = row
        .and_then(|r| map_bool(r, "is_active"))
        .or_else(|| existing.as_ref().map(|r| r.active))
        .unwrap_or(true);
    let mut deleted = existing.as_ref().map(|r| r.deleted).unwrap_or(false);
    if let Some(value) = deleted_override {
        deleted = value;
        if value {
            active = false;
        }
    }

    let fallback_json = existing.as_ref().map(|r| r.row_json.as_str());
    let row_json = row_json_or_default(payload, fallback_json, &format!(r#"{{"user_id":{}}}"#, user_id));

    let next = StateUser {
        user_id,
        username_lc: username.as_ref().map(|s| s.to_lowercase()),
        handle_lc: normalize_handle_lc(handle.as_deref()),
        username,
        handle,
        active,
        deleted,
        row_json,
        last_updated_at: ctx.timestamp,
    };
    let next_snapshot = next.clone();

    if existing.is_some() {
        ctx.db.state_user().user_id().update(next);
    } else {
        ctx.db.state_user().insert(next);
    }

    set_next_user_id(ctx, user_id);

    if previous_username_lc.as_deref() != next_snapshot.username_lc.as_deref() {
        remove_username_lookup(ctx, previous_username_lc.as_deref());
    }
    if previous_handle_lc.as_deref() != next_snapshot.handle_lc.as_deref() {
        remove_handle_lookup(ctx, previous_handle_lc.as_deref());
    }

    if next_snapshot.active && !next_snapshot.deleted {
        upsert_username_lookup(ctx, next_snapshot.username_lc.as_deref(), user_id);
        upsert_handle_lookup(ctx, next_snapshot.handle_lc.as_deref(), user_id);
    } else {
        remove_username_lookup(ctx, next_snapshot.username_lc.as_deref());
        remove_handle_lookup(ctx, next_snapshot.handle_lc.as_deref());
    }
}

fn apply_session_upsert(ctx: &ReducerContext, payload: &Value, deleted_override: Option<bool>) {
    let row = payload_row_obj(payload);
    let Some(session_id) = row
        .and_then(|r| map_string(r, "session_id"))
        .or_else(|| payload_string(payload, "sessionId"))
    else {
        return;
    };

    let existing = ctx.db.state_session().session_id().find(&session_id);

    let user_id = row
        .and_then(|r| map_i64(r, "user_id"))
        .or_else(|| payload_i64(payload, "userId"))
        .or_else(|| existing.as_ref().and_then(|r| r.user_id));
    let expires_at = row
        .and_then(|r| map_i64(r, "expires_at"))
        .or_else(|| existing.as_ref().and_then(|r| r.expires_at));
    let is_temporary = row
        .and_then(|r| map_bool(r, "is_temporary"))
        .or_else(|| payload_bool(payload, "isTemporary"))
        .or_else(|| existing.as_ref().map(|r| r.is_temporary))
        .unwrap_or(false);
    let mut deleted = existing.as_ref().map(|r| r.deleted).unwrap_or(false);
    if let Some(value) = row.and_then(|r| map_bool(r, "deleted")) {
        deleted = value;
    }
    if let Some(value) = deleted_override {
        deleted = value;
    }

    let fallback_json = existing.as_ref().map(|r| r.row_json.as_str());
    let row_json = row_json_or_default(
        payload,
        fallback_json,
        &format!(r#"{{"session_id":"{}"}}"#, session_id),
    );

    let next = StateSession {
        session_id: session_id.clone(),
        user_id,
        expires_at,
        is_temporary,
        deleted,
        row_json,
        last_updated_at: ctx.timestamp,
    };

    if existing.is_some() {
        ctx.db.state_session().session_id().update(next);
    } else {
        ctx.db.state_session().insert(next);
    }
}

fn apply_session_cleanup(ctx: &ReducerContext, payload: &Value) {
    let mut touched = false;
    for session_id in payload_array_strings(payload, "sessionIds") {
        if let Some(existing) = ctx.db.state_session().session_id().find(&session_id) {
            let mut row = existing.clone();
            row.deleted = true;
            row.last_updated_at = ctx.timestamp;
            ctx.db.state_session().session_id().update(row);
            touched = true;
        }
    }
    if touched {
        return;
    }

    let now = payload_i64(payload, "now").unwrap_or(0);
    if now <= 0 {
        return;
    }
    let ids: Vec<String> = ctx
        .db
        .state_session()
        .iter()
        .filter(|row| !row.deleted && row.expires_at.map(|expires| expires < now).unwrap_or(false))
        .map(|row| row.session_id)
        .collect();
    for session_id in ids {
        if let Some(existing) = ctx.db.state_session().session_id().find(&session_id) {
            let mut row = existing.clone();
            row.deleted = true;
            row.last_updated_at = ctx.timestamp;
            ctx.db.state_session().session_id().update(row);
        }
    }
}

fn apply_rbac_upsert(ctx: &ReducerContext, payload: &Value, active: bool) {
    let user_id = payload_i64(payload, "userId").unwrap_or(0);
    let workspace_id = payload_string(payload, "workspaceId").unwrap_or_default();
    let role = payload_string(payload, "role").unwrap_or_default();
    if user_id <= 0 || workspace_id.is_empty() || role.is_empty() {
        return;
    }

    let key = payload_string(payload, "assignmentKey")
        .filter(|raw| !raw.trim().is_empty())
        .unwrap_or_else(|| assignment_key(&workspace_id, user_id, &role));
    let existing = ctx.db.state_rbac_assignment().assignment_key().find(&key);

    let assigned_by = payload_i64(payload, "assignedBy").or_else(|| existing.as_ref().and_then(|r| r.assigned_by));
    let fallback_json = existing.as_ref().map(|r| r.row_json.as_str());
    let row_json = row_json_or_default(
        payload,
        fallback_json,
        &format!(
            r#"{{"assignment_key":"{}","workspace_id":"{}","user_id":{},"role":"{}"}}"#,
            key, workspace_id, user_id, role
        ),
    );

    let next = StateRbacAssignment {
        assignment_key: key.clone(),
        workspace_id,
        user_id,
        role,
        assigned_by,
        active,
        row_json,
        last_updated_at: ctx.timestamp,
    };

    if existing.is_some() {
        ctx.db.state_rbac_assignment().assignment_key().update(next);
    } else {
        ctx.db.state_rbac_assignment().insert(next);
    }
}

fn apply_role_definition_upsert(ctx: &ReducerContext, payload: &Value, active: bool) {
    let row = payload_row_obj(payload);
    let workspace_id = row
        .and_then(|r| map_string(r, "workspace_id"))
        .or_else(|| payload_string(payload, "workspaceId"))
        .unwrap_or_default();
    let role_name = row
        .and_then(|r| map_string(r, "role_name"))
        .or_else(|| payload_string(payload, "roleName"))
        .unwrap_or_default();
    if workspace_id.is_empty() || role_name.is_empty() {
        return;
    }

    let key = payload_string(payload, "roleKey")
        .filter(|raw| !raw.trim().is_empty())
        .unwrap_or_else(|| role_key(&workspace_id, &role_name));
    let existing = ctx.db.state_role_definition().role_key().find(&key);

    let display_name = row
        .and_then(|r| map_string(r, "display_name"))
        .or_else(|| payload_string(payload, "displayName"))
        .or_else(|| existing.as_ref().map(|r| r.display_name.clone()))
        .unwrap_or_else(|| role_name.clone());
    let priority = row
        .and_then(|r| map_i64(r, "priority"))
        .or_else(|| payload_i64(payload, "priority"))
        .or_else(|| existing.as_ref().map(|r| r.priority))
        .unwrap_or(0);
    let color = row
        .and_then(|r| map_string(r, "color"))
        .or_else(|| payload_string(payload, "color"))
        .or_else(|| existing.as_ref().and_then(|r| r.color.clone()));
    let is_hoisted = row
        .and_then(|r| map_bool(r, "is_hoisted"))
        .or_else(|| payload_bool(payload, "isHoisted"))
        .or_else(|| existing.as_ref().map(|r| r.is_hoisted))
        .unwrap_or(false);

    let fallback_json = existing.as_ref().map(|r| r.row_json.as_str());
    let row_json = row_json_or_default(
        payload,
        fallback_json,
        &format!(
            r#"{{"role_name":"{}","workspace_id":"{}","display_name":"{}","priority":{},"is_hoisted":{}}}"#,
            role_name, workspace_id, display_name, priority, is_hoisted
        ),
    );

    let next = StateRoleDefinition {
        role_key: key.clone(),
        workspace_id,
        role_name,
        display_name,
        priority,
        color,
        is_hoisted,
        active,
        row_json,
        last_updated_at: ctx.timestamp,
    };

    if existing.is_some() {
        ctx.db.state_role_definition().role_key().update(next);
    } else {
        ctx.db.state_role_definition().insert(next);
    }
}

fn apply_user_settings_upsert(ctx: &ReducerContext, payload: &Value) {
    let row = payload_row_obj(payload);
    let user_id = row
        .and_then(|r| map_i64(r, "user_id"))
        .or_else(|| payload_i64(payload, "userId"))
        .unwrap_or(0);
    if user_id <= 0 {
        return;
    }

    let existing = ctx.db.state_user_settings().user_id().find(&user_id);
    let offline_message_retention = row
        .and_then(|r| map_string(r, "offline_message_retention"))
        .or_else(|| existing.as_ref().map(|r| r.offline_message_retention.clone()))
        .unwrap_or_else(|| "7d".to_string());
    let allow_temp_user_messages = row
        .and_then(|r| map_bool(r, "allow_temp_user_messages"))
        .or_else(|| existing.as_ref().map(|r| r.allow_temp_user_messages))
        .unwrap_or(true);
    let business_private_mode = row
        .and_then(|r| map_bool(r, "business_private_mode"))
        .or_else(|| existing.as_ref().map(|r| r.business_private_mode))
        .unwrap_or(false);
    let home_experience = row
        .and_then(|r| map_string(r, "home_experience"))
        .or_else(|| existing.as_ref().map(|r| r.home_experience.clone()))
        .unwrap_or_else(|| "community".to_string());
    let require_password_change = row
        .and_then(|r| map_bool(r, "require_password_change"))
        .or_else(|| existing.as_ref().map(|r| r.require_password_change))
        .unwrap_or(false);
    let payment_preferred_route = row
        .and_then(|r| map_string(r, "payment_preferred_route"))
        .or_else(|| existing.as_ref().and_then(|r| r.payment_preferred_route.clone()))
        .map(|value| value.trim().to_uppercase())
        .filter(|value| !value.is_empty());

    let fallback_json = existing.as_ref().map(|r| r.row_json.as_str());
    let row_json = row_json_or_default(
        payload,
        fallback_json,
        &format!(
            r#"{{"user_id":{},"offline_message_retention":"{}","allow_temp_user_messages":{},"business_private_mode":{},"home_experience":"{}","require_password_change":{},"payment_preferred_route":{}}}"#,
            user_id,
            offline_message_retention,
            allow_temp_user_messages,
            business_private_mode,
            home_experience,
            require_password_change,
            payment_preferred_route
                .as_ref()
                .map(|value| format!(r#""{}""#, value))
                .unwrap_or_else(|| "null".to_string())
        ),
    );

    let next = StateUserSettings {
        user_id,
        offline_message_retention,
        allow_temp_user_messages,
        business_private_mode,
        home_experience,
        require_password_change,
        payment_preferred_route,
        row_json,
        last_updated_at: ctx.timestamp,
    };

    if existing.is_some() {
        ctx.db.state_user_settings().user_id().update(next);
    } else {
        ctx.db.state_user_settings().insert(next);
    }
}

fn apply_theme_preferences_upsert(ctx: &ReducerContext, payload: &Value) {
    let row = payload_row_obj(payload);
    let user_id = row
        .and_then(|r| map_i64(r, "user_id"))
        .or_else(|| payload_i64(payload, "userId"))
        .unwrap_or(0);
    if user_id <= 0 {
        return;
    }

    let existing = ctx.db.state_theme_preferences().user_id().find(&user_id);
    let theme_id = row
        .and_then(|r| map_string(r, "theme_id"))
        .or_else(|| existing.as_ref().map(|r| r.theme_id.clone()))
        .unwrap_or_else(|| "midnight-blue".to_string());
    let custom_theme = row
        .and_then(|r| map_string(r, "custom_theme"))
        .or_else(|| existing.as_ref().and_then(|r| r.custom_theme.clone()));
    let uniform_font_enabled = row
        .and_then(|r| map_bool(r, "uniform_font_enabled"))
        .or_else(|| existing.as_ref().map(|r| r.uniform_font_enabled))
        .unwrap_or(false);
    let uniform_font_family = row
        .and_then(|r| map_string(r, "uniform_font_family"))
        .or_else(|| existing.as_ref().map(|r| r.uniform_font_family.clone()))
        .unwrap_or_else(|| "inherit".to_string());
    let uniform_font_size = row
        .and_then(|r| map_string(r, "uniform_font_size"))
        .or_else(|| existing.as_ref().map(|r| r.uniform_font_size.clone()))
        .unwrap_or_else(|| "inherit".to_string());
    let uniform_font_weight = row
        .and_then(|r| map_string(r, "uniform_font_weight"))
        .or_else(|| existing.as_ref().map(|r| r.uniform_font_weight.clone()))
        .unwrap_or_else(|| "600".to_string());
    let uniform_font_style = row
        .and_then(|r| map_string(r, "uniform_font_style"))
        .or_else(|| existing.as_ref().map(|r| r.uniform_font_style.clone()))
        .unwrap_or_else(|| "normal".to_string());

    let fallback_json = existing.as_ref().map(|r| r.row_json.as_str());
    let row_json = row_json_or_default(
        payload,
        fallback_json,
        &format!(
            r#"{{"user_id":{},"theme_id":"{}","uniform_font_enabled":{},"uniform_font_family":"{}","uniform_font_size":"{}","uniform_font_weight":"{}","uniform_font_style":"{}"}}"#,
            user_id,
            theme_id,
            uniform_font_enabled,
            uniform_font_family,
            uniform_font_size,
            uniform_font_weight,
            uniform_font_style
        ),
    );

    let next = StateThemePreferences {
        user_id,
        theme_id,
        custom_theme,
        uniform_font_enabled,
        uniform_font_family,
        uniform_font_size,
        uniform_font_weight,
        uniform_font_style,
        row_json,
        last_updated_at: ctx.timestamp,
    };

    if existing.is_some() {
        ctx.db.state_theme_preferences().user_id().update(next);
    } else {
        ctx.db.state_theme_preferences().insert(next);
    }
}

fn apply_user_encryption_key_upsert(ctx: &ReducerContext, payload: &Value) {
    let row = payload_row_obj(payload);
    let user_id = row
        .and_then(|r| map_i64(r, "user_id"))
        .or_else(|| payload_i64(payload, "userId"))
        .unwrap_or(0);
    if user_id <= 0 {
        return;
    }

    let existing = ctx.db.state_user_encryption_key().user_id().find(&user_id);
    let public_key = row
        .and_then(|r| map_string(r, "public_key"))
        .or_else(|| payload_string(payload, "publicKey"))
        .or_else(|| existing.as_ref().map(|r| r.public_key.clone()))
        .unwrap_or_default();
    let private_key_encrypted = row
        .and_then(|r| map_string(r, "private_key_encrypted"))
        .or_else(|| payload_string(payload, "privateKeyEncrypted"))
        .or_else(|| existing.as_ref().map(|r| r.private_key_encrypted.clone()))
        .unwrap_or_default();
    if public_key.is_empty() || private_key_encrypted.is_empty() {
        return;
    }
    let created_at = row
        .and_then(|r| map_i64(r, "created_at"))
        .or_else(|| payload_i64(payload, "createdAt"))
        .or_else(|| existing.as_ref().map(|r| r.created_at))
        .unwrap_or(0);

    let fallback_json = existing.as_ref().map(|r| r.row_json.as_str());
    let row_json = row_json_or_default(
        payload,
        fallback_json,
        &format!(
            r#"{{"user_id":{},"public_key":"{}","private_key_encrypted":"{}","created_at":{}}}"#,
            user_id,
            public_key,
            private_key_encrypted,
            created_at
        ),
    );

    let next = StateUserEncryptionKey {
        user_id,
        public_key,
        private_key_encrypted,
        created_at,
        row_json,
        last_updated_at: ctx.timestamp,
    };

    if existing.is_some() {
        ctx.db.state_user_encryption_key().user_id().update(next);
    } else {
        ctx.db.state_user_encryption_key().insert(next);
    }
}

fn apply_relay_upsert(ctx: &ReducerContext, payload: &Value) {
    let row = payload_row_obj(payload);
    let relay_id = row
        .and_then(|r| map_i64(r, "relay_id"))
        .or_else(|| payload_i64(payload, "relayId"))
        .unwrap_or(0);
    if relay_id <= 0 {
        return;
    }

    let existing = ctx.db.state_relay().relay_id().find(&relay_id);
    let url = row
        .and_then(|r| map_string(r, "url"))
        .or_else(|| existing.as_ref().map(|r| r.url.clone()))
        .unwrap_or_default();
    let name = row
        .and_then(|r| map_string(r, "name"))
        .or_else(|| existing.as_ref().map(|r| r.name.clone()))
        .unwrap_or_default();
    let region = row
        .and_then(|r| map_string(r, "region"))
        .or_else(|| existing.as_ref().map(|r| r.region.clone()))
        .unwrap_or_default();
    let api_key_hash = row
        .and_then(|r| map_string(r, "api_key_hash"))
        .or_else(|| existing.as_ref().map(|r| r.api_key_hash.clone()))
        .unwrap_or_default();
    if url.is_empty() || name.is_empty() || region.is_empty() || api_key_hash.is_empty() {
        return;
    }
    let status = row
        .and_then(|r| map_string(r, "status"))
        .or_else(|| existing.as_ref().map(|r| r.status.clone()))
        .unwrap_or_else(|| "pending".to_string());
    let last_health_ping = row
        .and_then(|r| map_i64(r, "last_health_ping"))
        .or_else(|| existing.as_ref().and_then(|r| r.last_health_ping));
    let registered_at = row
        .and_then(|r| map_i64(r, "registered_at"))
        .or_else(|| existing.as_ref().map(|r| r.registered_at))
        .unwrap_or(0);
    let approved = row
        .and_then(|r| map_bool(r, "approved"))
        .or_else(|| row.and_then(|r| map_i64(r, "approved")).map(|value| value != 0))
        .or_else(|| existing.as_ref().map(|r| r.approved))
        .unwrap_or(false);
    let latitude = row
        .and_then(|r| map_f64(r, "latitude"))
        .or_else(|| existing.as_ref().and_then(|r| r.latitude));
    let longitude = row
        .and_then(|r| map_f64(r, "longitude"))
        .or_else(|| existing.as_ref().and_then(|r| r.longitude));
    let bandwidth_mbps = row
        .and_then(|r| map_i64(r, "bandwidth_mbps"))
        .or_else(|| existing.as_ref().and_then(|r| r.bandwidth_mbps));
    let storage_gb = row
        .and_then(|r| map_i64(r, "storage_gb"))
        .or_else(|| existing.as_ref().and_then(|r| r.storage_gb));
    let syncthing_device_id = row
        .and_then(|r| map_string(r, "syncthing_device_id"))
        .or_else(|| existing.as_ref().and_then(|r| r.syncthing_device_id.clone()));
    let metadata_json = row
        .and_then(|r| map_string(r, "metadata_json"))
        .or_else(|| existing.as_ref().and_then(|r| r.metadata_json.clone()));

    let fallback_json = existing.as_ref().map(|r| r.row_json.as_str());
    let row_json = row_json_or_default(
        payload,
        fallback_json,
        &json!({
            "relay_id": relay_id,
            "url": url,
            "name": name,
            "region": region,
            "api_key_hash": api_key_hash,
            "status": status,
            "last_health_ping": last_health_ping,
            "registered_at": registered_at,
            "approved": approved,
            "latitude": latitude,
            "longitude": longitude,
            "bandwidth_mbps": bandwidth_mbps,
            "storage_gb": storage_gb,
            "syncthing_device_id": syncthing_device_id,
            "metadata_json": metadata_json
        })
        .to_string(),
    );

    let next = StateRelay {
        relay_id,
        url,
        name,
        region,
        api_key_hash,
        status,
        last_health_ping,
        registered_at,
        approved,
        latitude,
        longitude,
        bandwidth_mbps,
        storage_gb,
        syncthing_device_id,
        metadata_json,
        row_json,
        last_updated_at: ctx.timestamp,
    };

    if existing.is_some() {
        ctx.db.state_relay().relay_id().update(next);
    } else {
        ctx.db.state_relay().insert(next);
    }
}

fn apply_relay_delete(ctx: &ReducerContext, payload: &Value) {
    let relay_id = payload_i64(payload, "relayId")
        .or_else(|| payload_row_obj(payload).and_then(|row| map_i64(row, "relay_id")))
        .unwrap_or(0);
    if relay_id <= 0 {
        return;
    }

    if let Some(existing) = ctx.db.state_relay().relay_id().find(&relay_id) {
        ctx.db.state_relay().relay_id().delete(existing.relay_id);
    }
}

fn dictionary_entry_key(workspace_id: &str, language: &str, term_normalized: &str) -> String {
    format!("{workspace_id}:{language}:{term_normalized}")
}

fn apply_dictionary_entry_upsert(ctx: &ReducerContext, payload: &Value) {
    let row = payload_row_obj(payload);
    let workspace_id = row
        .and_then(|r| map_string_any(r, &["workspace_id", "workspaceId"]))
        .or_else(|| payload_string(payload, "workspaceId"))
        .unwrap_or_else(|| "default-workspace".to_string());
    let language = row
        .and_then(|r| map_string(r, "language"))
        .or_else(|| payload_string(payload, "language"))
        .unwrap_or_else(|| "en".to_string());
    let term_normalized = row
        .and_then(|r| map_string_any(r, &["term_normalized", "termNormalized"]))
        .or_else(|| payload_string(payload, "termNormalized"))
        .or_else(|| row.and_then(|r| map_string(r, "term")).map(|value| value.trim().to_lowercase()))
        .or_else(|| payload_string(payload, "term").map(|value| value.trim().to_lowercase()))
        .unwrap_or_default();
    if term_normalized.is_empty() {
        return;
    }

    let entry_key = row
        .and_then(|r| map_string_any(r, &["entry_key", "entryKey"]))
        .or_else(|| payload_string(payload, "entryKey"))
        .unwrap_or_else(|| dictionary_entry_key(&workspace_id, &language, &term_normalized));
    let existing = ctx.db.state_dictionary_entry().entry_key().find(&entry_key);
    let term = row
        .and_then(|r| map_string(r, "term"))
        .or_else(|| payload_string(payload, "term"))
        .or_else(|| existing.as_ref().map(|r| r.term.clone()))
        .unwrap_or_else(|| term_normalized.clone());
    let created_by_user_id = row
        .and_then(|r| map_i64_any(r, &["created_by_user_id", "createdByUserId"]))
        .or_else(|| payload_i64(payload, "createdByUserId"))
        .or_else(|| existing.as_ref().and_then(|r| r.created_by_user_id));
    let created_by_username = row
        .and_then(|r| map_string_any(r, &["created_by_username", "createdByUsername"]))
        .or_else(|| payload_string(payload, "createdByUsername"))
        .or_else(|| existing.as_ref().and_then(|r| r.created_by_username.clone()));
    let created_at = row
        .and_then(|r| map_i64_any(r, &["created_at", "createdAt"]))
        .or_else(|| payload_i64(payload, "createdAt"))
        .or_else(|| existing.as_ref().map(|r| r.created_at))
        .unwrap_or(0);
    let updated_at = row
        .and_then(|r| map_i64_any(r, &["updated_at", "updatedAt"]))
        .or_else(|| payload_i64(payload, "updatedAt"))
        .or_else(|| existing.as_ref().map(|r| r.updated_at))
        .unwrap_or(created_at);
    let votes = row
        .and_then(|r| map_i64(r, "votes"))
        .or_else(|| payload_i64(payload, "votes"))
        .or_else(|| existing.as_ref().map(|r| r.votes))
        .unwrap_or(0);

    let fallback_json = existing.as_ref().map(|r| r.row_json.as_str());
    let row_json = row_json_or_default(
        payload,
        fallback_json,
        &json!({
            "workspace_id": workspace_id,
            "term": term,
            "term_normalized": term_normalized,
            "definition": row
                .and_then(|r| map_string(r, "definition"))
                .or_else(|| payload_string(payload, "definition"))
                .unwrap_or_default(),
            "language": language,
            "created_by_user_id": created_by_user_id,
            "created_by_username": created_by_username,
            "created_at": created_at,
            "updated_at": updated_at,
            "votes": votes
        })
        .to_string(),
    );

    let next = StateDictionaryEntry {
        entry_key,
        workspace_id,
        language,
        term_normalized,
        term,
        created_by_user_id,
        created_by_username,
        created_at,
        updated_at,
        votes,
        row_json,
        last_updated_at: ctx.timestamp,
    };

    if existing.is_some() {
        ctx.db.state_dictionary_entry().entry_key().update(next);
    } else {
        ctx.db.state_dictionary_entry().insert(next);
    }
}

fn apply_dictionary_entry_delete(ctx: &ReducerContext, payload: &Value) {
    let row = payload_row_obj(payload);
    let workspace_id = row
        .and_then(|r| map_string_any(r, &["workspace_id", "workspaceId"]))
        .or_else(|| payload_string(payload, "workspaceId"))
        .unwrap_or_else(|| "default-workspace".to_string());
    let language = row
        .and_then(|r| map_string(r, "language"))
        .or_else(|| payload_string(payload, "language"))
        .unwrap_or_else(|| "en".to_string());
    let term_normalized = row
        .and_then(|r| map_string_any(r, &["term_normalized", "termNormalized"]))
        .or_else(|| payload_string(payload, "termNormalized"))
        .or_else(|| row.and_then(|r| map_string(r, "term")).map(|value| value.trim().to_lowercase()))
        .or_else(|| payload_string(payload, "term").map(|value| value.trim().to_lowercase()))
        .unwrap_or_default();
    if term_normalized.is_empty() {
        return;
    }

    let entry_key = row
        .and_then(|r| map_string_any(r, &["entry_key", "entryKey"]))
        .or_else(|| payload_string(payload, "entryKey"))
        .unwrap_or_else(|| dictionary_entry_key(&workspace_id, &language, &term_normalized));
    if let Some(existing) = ctx.db.state_dictionary_entry().entry_key().find(&entry_key) {
        ctx.db.state_dictionary_entry().entry_key().delete(existing.entry_key);
    }
}

fn apply_app_setting_upsert(ctx: &ReducerContext, payload: &Value) {
    let row = payload_row_obj(payload);
    let setting_key = row
        .and_then(|r| map_string_any(r, &["key", "setting_key", "settingKey"]))
        .or_else(|| payload_string(payload, "settingKey"))
        .unwrap_or_default();
    if setting_key.is_empty() {
        return;
    }

    let existing = ctx.db.state_app_setting().setting_key().find(&setting_key);
    let value = row
        .and_then(|r| map_string(r, "value"))
        .or_else(|| payload_string(payload, "value"))
        .or_else(|| existing.as_ref().map(|r| r.value.clone()))
        .unwrap_or_default();
    let updated_at = row
        .and_then(|r| map_i64_any(r, &["updated_at", "updatedAt"]))
        .or_else(|| payload_i64(payload, "updatedAt"))
        .or_else(|| existing.as_ref().map(|r| r.updated_at))
        .unwrap_or(0);
    let fallback_json = existing.as_ref().map(|r| r.row_json.as_str());
    let row_json = row_json_or_default(
        payload,
        fallback_json,
        &json!({
            "key": setting_key,
            "value": value,
            "updated_at": updated_at
        })
        .to_string(),
    );

    let next = StateAppSetting {
        setting_key,
        value,
        updated_at,
        row_json,
        last_updated_at: ctx.timestamp,
    };

    if existing.is_some() {
        ctx.db.state_app_setting().setting_key().update(next);
    } else {
        ctx.db.state_app_setting().insert(next);
    }
}

fn apply_backend_instance_lease_upsert(ctx: &ReducerContext, payload: &Value) {
    let row = payload_row_obj(payload);
    let instance_id = row
        .and_then(|r| map_string_any(r, &["instance_id", "instanceId"]))
        .or_else(|| payload_string(payload, "instanceId"))
        .unwrap_or_default();
    if instance_id.is_empty() {
        return;
    }

    let existing = ctx
        .db
        .state_backend_instance_lease()
        .instance_id()
        .find(&instance_id);
    let region = row
        .and_then(|r| map_string(r, "region"))
        .or_else(|| payload_string(payload, "region"))
        .or_else(|| existing.as_ref().map(|r| r.region.clone()))
        .unwrap_or_else(|| "local".to_string());
    let role = row
        .and_then(|r| map_string(r, "role"))
        .or_else(|| payload_string(payload, "role"))
        .or_else(|| existing.as_ref().map(|r| r.role.clone()))
        .unwrap_or_else(|| "backend".to_string());
    let status = row
        .and_then(|r| map_string(r, "status"))
        .or_else(|| payload_string(payload, "status"))
        .or_else(|| existing.as_ref().map(|r| r.status.clone()))
        .unwrap_or_else(|| "active".to_string());
    let current_connections = row
        .and_then(|r| map_i64_any(r, &["current_connections", "currentConnections"]))
        .or_else(|| payload_i64(payload, "currentConnections"))
        .or_else(|| existing.as_ref().map(|r| r.current_connections))
        .unwrap_or(0);
    let current_registered_users = row
        .and_then(|r| map_i64_any(r, &["current_registered_users", "currentRegisteredUsers"]))
        .or_else(|| payload_i64(payload, "currentRegisteredUsers"))
        .or_else(|| existing.as_ref().map(|r| r.current_registered_users))
        .unwrap_or(0);
    let current_guest_users = row
        .and_then(|r| map_i64_any(r, &["current_guest_users", "currentGuestUsers"]))
        .or_else(|| payload_i64(payload, "currentGuestUsers"))
        .or_else(|| existing.as_ref().map(|r| r.current_guest_users))
        .unwrap_or(0);
    let heartbeat_at = row
        .and_then(|r| map_i64_any(r, &["heartbeat_at", "heartbeatAt"]))
        .or_else(|| payload_i64(payload, "heartbeatAt"))
        .or_else(|| existing.as_ref().map(|r| r.heartbeat_at))
        .unwrap_or(0);
    let lease_expires_at = row
        .and_then(|r| map_i64_any(r, &["lease_expires_at", "leaseExpiresAt"]))
        .or_else(|| payload_i64(payload, "leaseExpiresAt"))
        .or_else(|| existing.as_ref().map(|r| r.lease_expires_at))
        .unwrap_or(0);
    let started_at = row
        .and_then(|r| map_i64_any(r, &["started_at", "startedAt"]))
        .or_else(|| payload_i64(payload, "startedAt"))
        .or_else(|| existing.as_ref().map(|r| r.started_at))
        .unwrap_or(heartbeat_at);

    if let Some(existing_row) = existing.as_ref() {
        if heartbeat_at > 0 && existing_row.heartbeat_at > heartbeat_at {
            return;
        }
    }

    let fallback_json = existing.as_ref().map(|r| r.row_json.as_str());
    let row_json = row_json_or_default(
        payload,
        fallback_json,
        &json!({
            "instance_id": instance_id,
            "region": region,
            "role": role,
            "status": status,
            "current_connections": current_connections,
            "current_registered_users": current_registered_users,
            "current_guest_users": current_guest_users,
            "heartbeat_at": heartbeat_at,
            "lease_expires_at": lease_expires_at,
            "started_at": started_at
        })
        .to_string(),
    );

    let next = StateBackendInstanceLease {
        instance_id: instance_id.clone(),
        region,
        role,
        status,
        current_connections,
        current_registered_users,
        current_guest_users,
        heartbeat_at,
        lease_expires_at,
        started_at,
        row_json,
        last_updated_at: ctx.timestamp,
    };

    if existing.is_some() {
        ctx.db
            .state_backend_instance_lease()
            .instance_id()
            .update(next);
    } else {
        ctx.db.state_backend_instance_lease().insert(next);
    }
}

fn apply_socket_lease_upsert(ctx: &ReducerContext, payload: &Value) {
    let row = payload_row_obj(payload);
    let stable_user_id = row
        .and_then(|r| map_string_any(r, &["stable_user_id", "stableUserId"]))
        .or_else(|| payload_string(payload, "stableUserId"))
        .unwrap_or_default();
    if stable_user_id.is_empty() {
        return;
    }

    let existing = ctx.db.state_socket_lease().stable_user_id().find(&stable_user_id);
    let db_user_id = row
        .and_then(|r| map_i64_any(r, &["db_user_id", "dbUserId"]))
        .or_else(|| payload_i64(payload, "dbUserId"))
        .or_else(|| existing.as_ref().and_then(|r| r.db_user_id));
    let instance_id = row
        .and_then(|r| map_string_any(r, &["instance_id", "instanceId"]))
        .or_else(|| payload_string(payload, "instanceId"))
        .or_else(|| existing.as_ref().map(|r| r.instance_id.clone()))
        .unwrap_or_default();
    if instance_id.is_empty() {
        return;
    }
    let status = row
        .and_then(|r| map_string(r, "status"))
        .or_else(|| payload_string(payload, "status"))
        .or_else(|| existing.as_ref().map(|r| r.status.clone()))
        .unwrap_or_else(|| "active".to_string());
    let connected_at = row
        .and_then(|r| map_i64_any(r, &["connected_at", "connectedAt"]))
        .or_else(|| payload_i64(payload, "connectedAt"))
        .or_else(|| existing.as_ref().map(|r| r.connected_at))
        .unwrap_or(0);
    let lease_expires_at = row
        .and_then(|r| map_i64_any(r, &["lease_expires_at", "leaseExpiresAt"]))
        .or_else(|| payload_i64(payload, "leaseExpiresAt"))
        .or_else(|| existing.as_ref().map(|r| r.lease_expires_at))
        .unwrap_or(0);

    if let Some(existing_row) = existing.as_ref() {
        if connected_at > 0 && existing_row.connected_at > connected_at {
            return;
        }
    }

    let fallback_json = existing.as_ref().map(|r| r.row_json.as_str());
    let row_json = row_json_or_default(
        payload,
        fallback_json,
        &json!({
            "stable_user_id": stable_user_id,
            "db_user_id": db_user_id,
            "instance_id": instance_id,
            "status": status,
            "connected_at": connected_at,
            "lease_expires_at": lease_expires_at
        })
        .to_string(),
    );

    let next = StateSocketLease {
        stable_user_id: stable_user_id.clone(),
        db_user_id,
        instance_id,
        status,
        connected_at,
        lease_expires_at,
        row_json,
        last_updated_at: ctx.timestamp,
    };

    if existing.is_some() {
        ctx.db.state_socket_lease().stable_user_id().update(next);
    } else {
        ctx.db.state_socket_lease().insert(next);
    }
}

fn apply_socket_lease_delete(ctx: &ReducerContext, payload: &Value) {
    let stable_user_id = payload_string(payload, "stableUserId")
        .or_else(|| payload_row_obj(payload).and_then(|row| map_string_any(row, &["stable_user_id", "stableUserId"])))
        .unwrap_or_default();
    if stable_user_id.is_empty() {
        return;
    }

    if let Some(existing) = ctx.db.state_socket_lease().stable_user_id().find(&stable_user_id) {
        let expected_connected_at = payload_i64(payload, "connectedAt")
            .or_else(|| payload_row_obj(payload).and_then(|row| map_i64_any(row, &["connected_at", "connectedAt"])));
        if let Some(expected_connected_at) = expected_connected_at {
            if expected_connected_at > 0 && existing.connected_at != expected_connected_at {
                return;
            }
        }
        ctx.db
            .state_socket_lease()
            .stable_user_id()
            .delete(existing.stable_user_id);
    }
}

fn apply_presence_lease_upsert(ctx: &ReducerContext, payload: &Value) {
    let row = payload_row_obj(payload);
    let stable_user_id = row
        .and_then(|r| map_string_any(r, &["stable_user_id", "stableUserId"]))
        .or_else(|| payload_string(payload, "stableUserId"))
        .unwrap_or_default();
    if stable_user_id.is_empty() {
        return;
    }

    let existing = ctx.db.state_presence_lease().stable_user_id().find(&stable_user_id);
    let db_user_id = row
        .and_then(|r| map_i64_any(r, &["db_user_id", "dbUserId"]))
        .or_else(|| payload_i64(payload, "dbUserId"))
        .or_else(|| existing.as_ref().and_then(|r| r.db_user_id));
    let instance_id = row
        .and_then(|r| map_string_any(r, &["instance_id", "instanceId"]))
        .or_else(|| payload_string(payload, "instanceId"))
        .or_else(|| existing.as_ref().map(|r| r.instance_id.clone()))
        .unwrap_or_default();
    if instance_id.is_empty() {
        return;
    }
    let username = row
        .and_then(|r| map_string(r, "username"))
        .or_else(|| payload_string(payload, "username"))
        .or_else(|| existing.as_ref().and_then(|r| r.username.clone()));
    let color = row
        .and_then(|r| map_string(r, "color"))
        .or_else(|| payload_string(payload, "color"))
        .or_else(|| existing.as_ref().and_then(|r| r.color.clone()));
    let profile_picture = row
        .and_then(|r| map_string_any(r, &["profile_picture", "profilePicture"]))
        .or_else(|| payload_string(payload, "profilePicture"))
        .or_else(|| existing.as_ref().and_then(|r| r.profile_picture.clone()));
    let status = row
        .and_then(|r| map_string(r, "status"))
        .or_else(|| payload_string(payload, "status"))
        .or_else(|| existing.as_ref().map(|r| r.status.clone()))
        .unwrap_or_else(|| "active".to_string());
    let connected_at = row
        .and_then(|r| map_i64_any(r, &["connected_at", "connectedAt"]))
        .or_else(|| payload_i64(payload, "connectedAt"))
        .or_else(|| existing.as_ref().map(|r| r.connected_at))
        .unwrap_or(0);
    let lease_expires_at = row
        .and_then(|r| map_i64_any(r, &["lease_expires_at", "leaseExpiresAt"]))
        .or_else(|| payload_i64(payload, "leaseExpiresAt"))
        .or_else(|| existing.as_ref().map(|r| r.lease_expires_at))
        .unwrap_or(0);

    if let Some(existing_row) = existing.as_ref() {
        if connected_at > 0 && existing_row.connected_at > connected_at {
            return;
        }
    }

    let fallback_json = existing.as_ref().map(|r| r.row_json.as_str());
    let row_json = row_json_or_default(
        payload,
        fallback_json,
        &json!({
            "stable_user_id": stable_user_id,
            "db_user_id": db_user_id,
            "instance_id": instance_id,
            "username": username,
            "color": color,
            "profile_picture": profile_picture,
            "status": status,
            "connected_at": connected_at,
            "lease_expires_at": lease_expires_at
        })
        .to_string(),
    );

    let next = StatePresenceLease {
        stable_user_id: stable_user_id.clone(),
        db_user_id,
        instance_id,
        username,
        color,
        profile_picture,
        status,
        connected_at,
        lease_expires_at,
        row_json,
        last_updated_at: ctx.timestamp,
    };

    if existing.is_some() {
        ctx.db.state_presence_lease().stable_user_id().update(next);
    } else {
        ctx.db.state_presence_lease().insert(next);
    }
}

fn apply_presence_lease_delete(ctx: &ReducerContext, payload: &Value) {
    let stable_user_id = payload_string(payload, "stableUserId")
        .or_else(|| payload_row_obj(payload).and_then(|row| map_string_any(row, &["stable_user_id", "stableUserId"])))
        .unwrap_or_default();
    if stable_user_id.is_empty() {
        return;
    }

    if let Some(existing) = ctx.db.state_presence_lease().stable_user_id().find(&stable_user_id) {
        let expected_connected_at = payload_i64(payload, "connectedAt")
            .or_else(|| payload_row_obj(payload).and_then(|row| map_i64_any(row, &["connected_at", "connectedAt"])));
        if let Some(expected_connected_at) = expected_connected_at {
            if expected_connected_at > 0 && existing.connected_at != expected_connected_at {
                return;
            }
        }
        ctx.db
            .state_presence_lease()
            .stable_user_id()
            .delete(existing.stable_user_id);
    }
}

fn apply_payment_intent_upsert(ctx: &ReducerContext, payload: &Value) {
    let row = payload_row_obj(payload);
    let intent_id = row
        .and_then(|r| map_string_any(r, &["intent_id", "intentId"]))
        .or_else(|| payload_string(payload, "intentId"))
        .unwrap_or_default();
    if intent_id.is_empty() {
        return;
    }

    let existing = ctx.db.state_payment_intent().intent_id().find(&intent_id);
    let workspace_id = row
        .and_then(|r| map_string_any(r, &["workspace_id", "workspaceId"]))
        .or_else(|| payload_string(payload, "workspaceId"))
        .or_else(|| existing.as_ref().map(|r| r.workspace_id.clone()))
        .unwrap_or_else(|| "default-workspace".to_string());
    let plugin_id = row
        .and_then(|r| map_string_any(r, &["plugin_id", "pluginId"]))
        .or_else(|| payload_string(payload, "pluginId"))
        .or_else(|| existing.as_ref().map(|r| r.plugin_id.clone()))
        .unwrap_or_default();
    let provider_name = row
        .and_then(|r| map_string_any(r, &["provider_name", "providerName"]))
        .or_else(|| payload_string(payload, "providerName"))
        .or_else(|| existing.as_ref().map(|r| r.provider_name.clone()))
        .unwrap_or_default();
    if plugin_id.is_empty() || provider_name.is_empty() {
        return;
    }

    let created_by_user_id = row
        .and_then(|r| map_i64_any(r, &["created_by_user_id", "createdByUserId"]))
        .or_else(|| payload_i64(payload, "createdByUserId"))
        .or_else(|| existing.as_ref().and_then(|r| r.created_by_user_id));
    let channel_id = row
        .and_then(|r| map_string_any(r, &["channel_id", "channelId"]))
        .or_else(|| payload_string(payload, "channelId"))
        .or_else(|| existing.as_ref().and_then(|r| r.channel_id.clone()));
    let provider_intent_id = row
        .and_then(|r| map_string_any(r, &["provider_intent_id", "providerIntentId"]))
        .or_else(|| payload_string(payload, "providerIntentId"))
        .or_else(|| existing.as_ref().and_then(|r| r.provider_intent_id.clone()));
    let amount_minor = row
        .and_then(|r| map_i64_any(r, &["amount_minor", "amountMinor"]))
        .or_else(|| payload_i64(payload, "amountMinor"))
        .or_else(|| existing.as_ref().map(|r| r.amount_minor))
        .unwrap_or(0);
    let currency = row
        .and_then(|r| map_string_any(r, &["currency"]))
        .or_else(|| payload_string(payload, "currency"))
        .or_else(|| existing.as_ref().map(|r| r.currency.clone()))
        .unwrap_or_else(|| "USD".to_string());
    let country_code = row
        .and_then(|r| map_string_any(r, &["country_code", "countryCode"]))
        .or_else(|| payload_string(payload, "countryCode"))
        .or_else(|| existing.as_ref().and_then(|r| r.country_code.clone()));
    let status = row
        .and_then(|r| map_string_any(r, &["status"]))
        .or_else(|| payload_string(payload, "status"))
        .or_else(|| existing.as_ref().map(|r| r.status.clone()))
        .unwrap_or_else(|| "draft".to_string());
    let checkout_mode = row
        .and_then(|r| map_string_any(r, &["checkout_mode", "checkoutMode"]))
        .or_else(|| payload_string(payload, "checkoutMode"))
        .or_else(|| existing.as_ref().map(|r| r.checkout_mode.clone()))
        .unwrap_or_else(|| "payment_link".to_string());
    let idempotency_key = row
        .and_then(|r| map_string_any(r, &["idempotency_key", "idempotencyKey"]))
        .or_else(|| payload_string(payload, "idempotencyKey"))
        .or_else(|| existing.as_ref().and_then(|r| r.idempotency_key.clone()));
    let created_at = row
        .and_then(|r| map_i64_any(r, &["created_at", "createdAt"]))
        .or_else(|| payload_i64(payload, "createdAt"))
        .or_else(|| existing.as_ref().map(|r| r.created_at))
        .unwrap_or(0);
    let updated_at = row
        .and_then(|r| map_i64_any(r, &["updated_at", "updatedAt"]))
        .or_else(|| payload_i64(payload, "updatedAt"))
        .or_else(|| existing.as_ref().map(|r| r.updated_at))
        .unwrap_or(created_at);

    let fallback_json = existing.as_ref().map(|r| r.row_json.as_str());
    let row_json = row_json_or_default(payload, fallback_json, "{}");

    let next = StatePaymentIntent {
        intent_id,
        workspace_id,
        created_by_user_id,
        channel_id,
        plugin_id,
        provider_name,
        provider_intent_id,
        amount_minor,
        currency,
        country_code,
        status,
        checkout_mode,
        idempotency_key,
        created_at,
        updated_at,
        row_json,
        last_updated_at: ctx.timestamp,
    };

    if existing.is_some() {
        ctx.db.state_payment_intent().intent_id().update(next);
    } else {
        ctx.db.state_payment_intent().insert(next);
    }
}

fn apply_payment_event_upsert(ctx: &ReducerContext, payload: &Value) {
    let row = payload_row_obj(payload);
    let event_id = row
        .and_then(|r| map_string_any(r, &["event_id", "eventId"]))
        .or_else(|| payload_string(payload, "eventId"))
        .unwrap_or_default();
    if event_id.is_empty() {
        return;
    }
    if ctx.db.state_payment_event().event_id().find(&event_id).is_some() {
        return;
    }

    let intent_id = row
        .and_then(|r| map_string_any(r, &["intent_id", "intentId"]))
        .or_else(|| payload_string(payload, "intentId"))
        .unwrap_or_default();
    let event_type = row
        .and_then(|r| map_string_any(r, &["event_type", "eventType"]))
        .or_else(|| payload_string(payload, "eventType"))
        .unwrap_or_default();
    let source = row
        .and_then(|r| map_string_any(r, &["source"]))
        .or_else(|| payload_string(payload, "source"))
        .unwrap_or_default();
    if intent_id.is_empty() || event_type.is_empty() || source.is_empty() {
        return;
    }

    let status = row
        .and_then(|r| map_string_any(r, &["status"]))
        .or_else(|| payload_string(payload, "status"));
    let idempotency_key = row
        .and_then(|r| map_string_any(r, &["idempotency_key", "idempotencyKey"]))
        .or_else(|| payload_string(payload, "idempotencyKey"));
    let created_at = row
        .and_then(|r| map_i64_any(r, &["created_at", "createdAt"]))
        .or_else(|| payload_i64(payload, "createdAt"))
        .unwrap_or(0);
    let row_json = row_json_or_default(payload, None, "{}");

    ctx.db.state_payment_event().insert(StatePaymentEvent {
        event_id,
        intent_id,
        event_type,
        status,
        source,
        idempotency_key,
        created_at,
        row_json,
        last_updated_at: ctx.timestamp,
    });
}

fn apply_manual_settlement_upsert(ctx: &ReducerContext, payload: &Value) {
    let row = payload_row_obj(payload);
    let settlement_id = row
        .and_then(|r| map_string_any(r, &["settlement_id", "settlementId"]))
        .or_else(|| payload_string(payload, "settlementId"))
        .unwrap_or_default();
    if settlement_id.is_empty() {
        return;
    }

    let existing = ctx.db.state_manual_settlement().settlement_id().find(&settlement_id);
    let workspace_id = row
        .and_then(|r| map_string_any(r, &["workspace_id", "workspaceId"]))
        .or_else(|| payload_string(payload, "workspaceId"))
        .or_else(|| existing.as_ref().map(|r| r.workspace_id.clone()))
        .unwrap_or_else(|| "default-workspace".to_string());
    let settlement_kind = row
        .and_then(|r| map_string_any(r, &["settlement_kind", "settlementKind"]))
        .or_else(|| payload_string(payload, "settlementKind"))
        .or_else(|| existing.as_ref().map(|r| r.settlement_kind.clone()))
        .unwrap_or_default();
    if settlement_kind.is_empty() {
        return;
    }
    let created_by_user_id = row
        .and_then(|r| map_i64_any(r, &["created_by_user_id", "createdByUserId"]))
        .or_else(|| payload_i64(payload, "createdByUserId"))
        .or_else(|| existing.as_ref().map(|r| r.created_by_user_id))
        .unwrap_or(0);
    if created_by_user_id <= 0 {
        return;
    }

    let channel_id = row
        .and_then(|r| map_string_any(r, &["channel_id", "channelId"]))
        .or_else(|| payload_string(payload, "channelId"))
        .or_else(|| existing.as_ref().and_then(|r| r.channel_id.clone()));
    let counterparty_user_id = row
        .and_then(|r| map_i64_any(r, &["counterparty_user_id", "counterpartyUserId"]))
        .or_else(|| payload_i64(payload, "counterpartyUserId"))
        .or_else(|| existing.as_ref().and_then(|r| r.counterparty_user_id));
    let status = row
        .and_then(|r| map_string_any(r, &["status"]))
        .or_else(|| payload_string(payload, "status"))
        .or_else(|| existing.as_ref().map(|r| r.status.clone()))
        .unwrap_or_else(|| "pending".to_string());
    let currency = row
        .and_then(|r| map_string_any(r, &["currency"]))
        .or_else(|| payload_string(payload, "currency"))
        .or_else(|| existing.as_ref().map(|r| r.currency.clone()))
        .unwrap_or_else(|| "USD".to_string());
    let amount_minor = row
        .and_then(|r| map_i64_any(r, &["amount_minor", "amountMinor"]))
        .or_else(|| payload_i64(payload, "amountMinor"))
        .or_else(|| existing.as_ref().map(|r| r.amount_minor))
        .unwrap_or(0);
    let completed_at = row
        .and_then(|r| map_i64_any(r, &["completed_at", "completedAt"]))
        .or_else(|| payload_i64(payload, "completedAt"))
        .or_else(|| existing.as_ref().and_then(|r| r.completed_at));
    let voided_at = row
        .and_then(|r| map_i64_any(r, &["voided_at", "voidedAt"]))
        .or_else(|| payload_i64(payload, "voidedAt"))
        .or_else(|| existing.as_ref().and_then(|r| r.voided_at));
    let created_at = row
        .and_then(|r| map_i64_any(r, &["created_at", "createdAt"]))
        .or_else(|| payload_i64(payload, "createdAt"))
        .or_else(|| existing.as_ref().map(|r| r.created_at))
        .unwrap_or(0);
    let updated_at = row
        .and_then(|r| map_i64_any(r, &["updated_at", "updatedAt"]))
        .or_else(|| payload_i64(payload, "updatedAt"))
        .or_else(|| existing.as_ref().map(|r| r.updated_at))
        .unwrap_or(created_at);

    let fallback_json = existing.as_ref().map(|r| r.row_json.as_str());
    let row_json = row_json_or_default(payload, fallback_json, "{}");

    let next = StateManualSettlement {
        settlement_id,
        workspace_id,
        settlement_kind,
        channel_id,
        created_by_user_id,
        counterparty_user_id,
        status,
        currency,
        amount_minor,
        completed_at,
        voided_at,
        created_at,
        updated_at,
        row_json,
        last_updated_at: ctx.timestamp,
    };

    if existing.is_some() {
        ctx.db.state_manual_settlement().settlement_id().update(next);
    } else {
        ctx.db.state_manual_settlement().insert(next);
    }
}

fn apply_payment_account_link_upsert(ctx: &ReducerContext, payload: &Value) {
    let row = payload_row_obj(payload);
    let user_id = row
        .and_then(|r| map_i64_any(r, &["user_id", "userId"]))
        .or_else(|| payload_i64(payload, "userId"))
        .unwrap_or(0);
    let workspace_id = row
        .and_then(|r| map_string_any(r, &["workspace_id", "workspaceId"]))
        .or_else(|| payload_string(payload, "workspaceId"))
        .unwrap_or_else(|| "default-workspace".to_string());
    let plugin_id = row
        .and_then(|r| map_string_any(r, &["plugin_id", "pluginId"]))
        .or_else(|| payload_string(payload, "pluginId"))
        .unwrap_or_default();
    if user_id <= 0 || plugin_id.is_empty() {
        return;
    }

    let key = payment_account_link_key(&workspace_id, user_id, &plugin_id);
    let existing = ctx.db.state_payment_account_link().account_link_key().find(&key);
    let updated_at = row
        .and_then(|r| map_i64_any(r, &["updated_at", "updatedAt"]))
        .or_else(|| payload_i64(payload, "updatedAt"))
        .or_else(|| existing.as_ref().map(|r| r.updated_at))
        .unwrap_or(0);
    let fallback_json = existing.as_ref().map(|r| r.row_json.as_str());
    let row_json = row_json_or_default(payload, fallback_json, "{}");

    let next = StatePaymentAccountLink {
        account_link_key: key,
        user_id,
        workspace_id,
        plugin_id,
        updated_at,
        row_json,
        last_updated_at: ctx.timestamp,
    };

    if existing.is_some() {
        ctx.db.state_payment_account_link().account_link_key().update(next);
    } else {
        ctx.db.state_payment_account_link().insert(next);
    }
}

fn apply_payment_account_link_delete(ctx: &ReducerContext, payload: &Value) {
    let row = payload_row_obj(payload);
    let user_id = row
        .and_then(|r| map_i64_any(r, &["user_id", "userId"]))
        .or_else(|| payload_i64(payload, "userId"))
        .unwrap_or(0);
    let workspace_id = row
        .and_then(|r| map_string_any(r, &["workspace_id", "workspaceId"]))
        .or_else(|| payload_string(payload, "workspaceId"))
        .unwrap_or_else(|| "default-workspace".to_string());
    let plugin_id = row
        .and_then(|r| map_string_any(r, &["plugin_id", "pluginId"]))
        .or_else(|| payload_string(payload, "pluginId"))
        .unwrap_or_default();
    if user_id <= 0 || plugin_id.is_empty() {
        return;
    }

    let key = payment_account_link_key(&workspace_id, user_id, &plugin_id);
    if let Some(existing) = ctx.db.state_payment_account_link().account_link_key().find(&key) {
        ctx.db.state_payment_account_link().account_link_key().delete(&existing.account_link_key);
    }
}

fn apply_payment_user_block_upsert(ctx: &ReducerContext, payload: &Value) {
    let row = payload_row_obj(payload);
    let user_id = row
        .and_then(|r| map_i64_any(r, &["user_id", "userId"]))
        .or_else(|| payload_i64(payload, "userId"))
        .unwrap_or(0);
    let workspace_id = row
        .and_then(|r| map_string_any(r, &["workspace_id", "workspaceId"]))
        .or_else(|| payload_string(payload, "workspaceId"))
        .unwrap_or_else(|| "default-workspace".to_string());
    if user_id <= 0 {
        return;
    }

    let key = payment_user_block_key(&workspace_id, user_id);
    let existing = ctx.db.state_payment_user_block().block_key().find(&key);
    let blocked_by_user_id = row
        .and_then(|r| map_i64_any(r, &["blocked_by_user_id", "blockedByUserId"]))
        .or_else(|| payload_i64(payload, "blockedByUserId"))
        .or_else(|| existing.as_ref().and_then(|r| r.blocked_by_user_id));
    let blocked_at = row
        .and_then(|r| map_i64_any(r, &["blocked_at", "blockedAt"]))
        .or_else(|| payload_i64(payload, "blockedAt"))
        .or_else(|| existing.as_ref().map(|r| r.blocked_at))
        .unwrap_or(0);
    let expires_at = row
        .and_then(|r| map_i64_any(r, &["expires_at", "expiresAt"]))
        .or_else(|| payload_i64(payload, "expiresAt"))
        .or_else(|| existing.as_ref().and_then(|r| r.expires_at));
    let fallback_json = existing.as_ref().map(|r| r.row_json.as_str());
    let row_json = row_json_or_default(payload, fallback_json, "{}");

    let next = StatePaymentUserBlock {
        block_key: key,
        user_id,
        workspace_id,
        blocked_by_user_id,
        blocked_at,
        expires_at,
        row_json,
        last_updated_at: ctx.timestamp,
    };

    if existing.is_some() {
        ctx.db.state_payment_user_block().block_key().update(next);
    } else {
        ctx.db.state_payment_user_block().insert(next);
    }
}

fn apply_payment_user_block_delete(ctx: &ReducerContext, payload: &Value) {
    let row = payload_row_obj(payload);
    let user_id = row
        .and_then(|r| map_i64_any(r, &["user_id", "userId"]))
        .or_else(|| payload_i64(payload, "userId"))
        .unwrap_or(0);
    let workspace_id = row
        .and_then(|r| map_string_any(r, &["workspace_id", "workspaceId"]))
        .or_else(|| payload_string(payload, "workspaceId"))
        .unwrap_or_else(|| "default-workspace".to_string());
    if user_id <= 0 {
        return;
    }

    let key = payment_user_block_key(&workspace_id, user_id);
    if let Some(existing) = ctx.db.state_payment_user_block().block_key().find(&key) {
        ctx.db.state_payment_user_block().block_key().delete(&existing.block_key);
    }
}

fn apply_payment_policy_upsert(ctx: &ReducerContext, payload: &Value) {
    let row = payload_row_obj(payload);
    let policy_key = row
        .and_then(|r| map_string_any(r, &["policy_key", "policyKey"]))
        .or_else(|| payload_string(payload, "policyKey"))
        .unwrap_or_default();
    if policy_key.is_empty() {
        return;
    }

    let existing = ctx.db.state_payment_policy().policy_key().find(&policy_key);
    let updated_at = row
        .and_then(|r| map_i64_any(r, &["updated_at", "updatedAt"]))
        .or_else(|| payload_i64(payload, "updatedAt"))
        .or_else(|| existing.as_ref().map(|r| r.updated_at))
        .unwrap_or(0);
    let fallback_json = existing.as_ref().map(|r| r.row_json.as_str());
    let row_json = row_json_or_default(payload, fallback_json, "{}");

    let next = StatePaymentPolicy {
        policy_key,
        updated_at,
        row_json,
        last_updated_at: ctx.timestamp,
    };

    if existing.is_some() {
        ctx.db.state_payment_policy().policy_key().update(next);
    } else {
        ctx.db.state_payment_policy().insert(next);
    }
}
