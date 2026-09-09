// Badge domain ops: assignable user badges backed by the WDB `user_badges`
// projection (see core/crates/wabidb/src/projections/badges.rs).
//
// Flow mirrors RBAC: admin-only socket commands ingest durable
// `badge_assigned` / `badge_removed` events through the adapter's generic
// funnel, then fan out the fresh badge list so every client re-renders
// name surfaces immediately.

/// A catalog entry an admin may assign. Rendered by the frontend's
/// RoleBadge component; `icon` is rendered verbatim (emoji for v1).
pub struct BadgeDef {
    pub id: &'static str,
    pub icon: &'static str,
    pub label: &'static str,
}

/// Server-wide assignable badge catalog. Role-derived badges (owner/admin/
/// mod/staff/bot) are NOT listed here — those render automatically from
/// `highestRole`. Keep ids stable: they are persisted in event payloads.
pub const BADGE_CATALOG: &[BadgeDef] = &[
    BadgeDef { id: "founder", icon: "👑", label: "Founder" },
    BadgeDef { id: "bug-hunter", icon: "🐛", label: "Bug Hunter" },
    // NOTE: no "artist" badge — the id collided with the real Artist
    // workspace role and trapped admins into thinking they'd granted Lore
    // access. Previously-assigned "artist" badge records are simply filtered
    // out by `badge_in_catalog` and stop rendering; no data migration needed.
    BadgeDef { id: "contributor", icon: "🛠️", label: "Contributor" },
    BadgeDef { id: "supporter", icon: "💜", label: "Supporter" },
    BadgeDef { id: "mod-star", icon: "⭐", label: "Star Mod" },
    BadgeDef { id: "event-winner", icon: "🏆", label: "Event Winner" },
    BadgeDef { id: "early-adopter", icon: "🚀", label: "Early Adopter" },
];

fn badge_in_catalog(badge_id: &str) -> bool {
    BADGE_CATALOG.iter().any(|d| d.id == badge_id)
}

fn badge_ids_json() -> serde_json::Value {
    serde_json::json!(BADGE_CATALOG
        .iter()
        .map(|d| serde_json::json!({ "id": d.id, "icon": d.icon, "label": d.label }))
        .collect::<Vec<_>>())
}

/// Current badge list for a user as JSON (array of `{ id, icon, label }`).
/// Catalog metadata is joined here so clients never need a second lookup.
async fn checked_badges_json_for(state: &SioState, db_user_id: i64) -> wabidb::error::Result<Value> {
    if db_user_id <= 0 {
        return Ok(json!([]));
    }
    let records = state.app.wdb.list_user_badges(db_user_id as u64).await?;
    Ok(json!(records
        .iter()
        .filter_map(|r| {
            BADGE_CATALOG.iter().find(|d| d.id == r.badge_id).map(|d| {
                serde_json::json!({ "id": d.id, "icon": d.icon, "label": d.label })
            })
        })
        .collect::<Vec<_>>()))
}

/// Best-effort decoration for roster initialization. Never use this fallback
/// to confirm a mutation: an unreadable list is not an authoritative empty list.
pub async fn badges_json_for(state: &SioState, db_user_id: i64) -> serde_json::Value {
    match checked_badges_json_for(state, db_user_id).await {
        Ok(badges) => badges,
        Err(e) => {
            warn!("[sio] badges_json_for({}) failed: {}", db_user_id, e);
            json!([])
        }
    }
}

#[allow(dead_code)]
pub async fn handle_get_badge_catalog(socket: SocketRef, state: &SioState) {
    let _ = socket.emit("badge-catalog", &badge_ids_json());
}

#[allow(dead_code)]
pub async fn handle_assign_badge(socket: SocketRef, data: Value, state: &SioState, io: &SocketIo) {
    let target_user_id = data.get("targetUserId").and_then(|v| v.as_i64()).unwrap_or(0);
    let badge_id = data.get("badgeId").and_then(|v| v.as_str()).unwrap_or("");
    let request_id = data.get("requestId").and_then(Value::as_str).filter(|id| !id.is_empty() && id.len() <= 128);
    // Correlate private receipts so a late error cannot settle a new People
    // action after navigation. Legacy callers may omit the optional request ID.
    let fail = |error: &str| {
        let _ = socket.emit("assign-badge-error", &json!({
            "error": error, "requestId": request_id,
            "targetUserId": target_user_id, "badgeId": badge_id,
        }));
    };

    if target_user_id <= 0 || badge_id.is_empty() {
        fail("Invalid badge request");
        return;
    }
    if !badge_in_catalog(badge_id) {
        fail("Unknown badge");
        return;
    }

    let Some(identity) = resolve_identity(&socket, state).await else {
        fail("Authentication required");
        return;
    };
    let caller_id = identity.user_id;
    if identity.is_guest || !state.app.is_admin(caller_id).await {
        warn!("[sio] assign-badge: user {} not authorized", caller_id);
        fail("Not authorized");
        return;
    }

    if let Err(e) = state.app.wdb.ingest_event("badges", "assign_badge", &json!({
        "userId": target_user_id,
        "badgeId": badge_id,
        "assignedBy": caller_id,
    })).await {
        warn!("[sio] assign-badge: failed: {}", e);
        fail("Failed to assign badge");
        return;
    }

    let badges = match checked_badges_json_for(state, target_user_id).await {
        Ok(badges) => badges,
        Err(error) => {
            warn!(user_id = target_user_id, %error, "persisted badge assignment could not be read back");
            fail("Badge change could not be confirmed");
            return;
        }
    };
    if let Err(error) = io.emit("user-badges-updated", &json!({
        "userId": format!("user-{}", target_user_id),
        "dbUserId": target_user_id,
        "badges": badges,
    })).await {
        warn!(user_id = target_user_id, %error, "persisted badge assignment could not be broadcast");
    }
    let _ = socket.emit("assign-badge-success", &json!({
        "requestId": request_id, "targetUserId": target_user_id, "badgeId": badge_id,
    }));
}

#[allow(dead_code)]
pub async fn handle_remove_badge(socket: SocketRef, data: Value, state: &SioState, io: &SocketIo) {
    let target_user_id = data.get("targetUserId").and_then(|v| v.as_i64()).unwrap_or(0);
    let badge_id = data.get("badgeId").and_then(|v| v.as_str()).unwrap_or("");
    let request_id = data.get("requestId").and_then(Value::as_str).filter(|id| !id.is_empty() && id.len() <= 128);
    let fail = |error: &str| {
        let _ = socket.emit("remove-badge-error", &json!({
            "error": error, "requestId": request_id,
            "targetUserId": target_user_id, "badgeId": badge_id,
        }));
    };

    if target_user_id <= 0 || badge_id.is_empty() {
        fail("Invalid badge request");
        return;
    }

    let Some(identity) = resolve_identity(&socket, state).await else {
        fail("Authentication required");
        return;
    };
    let caller_id = identity.user_id;
    if identity.is_guest || !state.app.is_admin(caller_id).await {
        warn!("[sio] remove-badge: user {} not authorized", caller_id);
        fail("Not authorized");
        return;
    }

    if let Err(e) = state.app.wdb.ingest_event("badges", "remove_badge", &json!({
        "userId": target_user_id,
        "badgeId": badge_id,
    })).await {
        warn!("[sio] remove-badge: failed: {}", e);
        fail("Failed to remove badge");
        return;
    }

    let badges = match checked_badges_json_for(state, target_user_id).await {
        Ok(badges) => badges,
        Err(error) => {
            warn!(user_id = target_user_id, %error, "persisted badge removal could not be read back");
            fail("Badge change could not be confirmed");
            return;
        }
    };
    if let Err(error) = io.emit("user-badges-updated", &json!({
        "userId": format!("user-{}", target_user_id),
        "dbUserId": target_user_id,
        "badges": badges,
    })).await {
        warn!(user_id = target_user_id, %error, "persisted badge removal could not be broadcast");
    }
    let _ = socket.emit("remove-badge-success", &json!({
        "requestId": request_id, "targetUserId": target_user_id, "badgeId": badge_id,
    }));
}
