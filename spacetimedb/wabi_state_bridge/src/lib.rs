use serde::Deserialize;
use serde_json::{Map, Value};
use spacetimedb::{ReducerContext, Table, Timestamp};

#[spacetimedb::table(accessor = ingested_event, public)]
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

#[spacetimedb::table(accessor = state_message, public)]
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

#[spacetimedb::table(accessor = state_channel, public)]
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

#[spacetimedb::table(accessor = state_channel_member, public)]
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

#[spacetimedb::table(accessor = state_user, public)]
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

#[spacetimedb::table(accessor = state_session, public)]
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

#[spacetimedb::table(accessor = state_rbac_assignment, public)]
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
}

#[spacetimedb::reducer]
pub fn ingest_wabi_event(ctx: &ReducerContext, event_json: String) -> Result<(), String> {
    let mut event: IngestEnvelope =
        serde_json::from_str(&event_json).map_err(|e| format!("invalid_event_json: {e}"))?;

    event.entity = event.entity.trim().to_lowercase();
    event.operation = event.operation.trim().to_string();
    if event.entity.is_empty() {
        return Err("event.entity is required".to_string());
    }
    if event.operation.is_empty() {
        return Err("event.operation is required".to_string());
    }

    let event_id = ensure_event_id(ctx, event.event_id.as_deref(), &event.entity, &event.operation)?;

    // Idempotent ingress: duplicate event IDs are accepted as no-op.
    if ctx.db.ingested_event().event_id().find(&event_id).is_some() {
        return Ok(());
    }

    let payload_json = serde_json::to_string(&event.payload).unwrap_or_else(|_| "{}".to_string());
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
        ("rbac", _) => {}

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

    if existing.is_some() {
        ctx.db.state_user().user_id().update(next);
    } else {
        ctx.db.state_user().insert(next);
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
