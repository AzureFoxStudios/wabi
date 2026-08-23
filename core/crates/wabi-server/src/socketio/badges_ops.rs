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
    BadgeDef { id: "artist", icon: "🎨", label: "Artist" },
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
pub async fn badges_json_for(state: &SioState, db_user_id: i64) -> serde_json::Value {
    if db_user_id <= 0 {
        return json!([]);
    }
    match state.app.wdb.list_user_badges(db_user_id as u64).await {
        Ok(records) => json!(records
            .iter()
            .filter_map(|r| {
                BADGE_CATALOG.iter().find(|d| d.id == r.badge_id).map(|d| {
                    serde_json::json!({ "id": d.id, "icon": d.icon, "label": d.label })
                })
            })
            .collect::<Vec<_>>()),
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

    if target_user_id <= 0 || badge_id.is_empty() {
        let _ = socket.emit("assign-badge-error", &json!({ "error": "Invalid badge request" }));
        return;
    }
    if !badge_in_catalog(badge_id) {
        let _ = socket.emit("assign-badge-error", &json!({ "error": "Unknown badge" }));
        return;
    }

    let identity = resolve_sio_identity(&socket);
    let caller_id = identity.as_ref().map(|i| i.user_id).unwrap_or(0);
    if !state.app.is_admin(caller_id).await {
        warn!("[sio] assign-badge: user {} not authorized", caller_id);
        let _ = socket.emit("assign-badge-error", &json!({ "error": "Not authorized" }));
        return;
    }

    if let Err(e) = state.app.wdb.ingest_event("badges", "assign_badge", &json!({
        "userId": target_user_id,
        "badgeId": badge_id,
        "assignedBy": caller_id,
    })).await {
        warn!("[sio] assign-badge: failed: {}", e);
        let _ = socket.emit("assign-badge-error", &json!({ "error": "Failed to assign badge" }));
        return;
    }

    let badges = badges_json_for(state, target_user_id).await;
    drop(io.emit("user-badges-updated", &json!({
        "userId": format!("user-{}", target_user_id),
        "dbUserId": target_user_id,
        "badges": badges,
    })));
    drop(socket.emit("assign-badge-success", &json!({ "targetUserId": target_user_id, "badgeId": badge_id })));
}

#[allow(dead_code)]
pub async fn handle_remove_badge(socket: SocketRef, data: Value, state: &SioState, io: &SocketIo) {
    let target_user_id = data.get("targetUserId").and_then(|v| v.as_i64()).unwrap_or(0);
    let badge_id = data.get("badgeId").and_then(|v| v.as_str()).unwrap_or("");

    if target_user_id <= 0 || badge_id.is_empty() {
        return;
    }

    let identity = resolve_sio_identity(&socket);
    let caller_id = identity.as_ref().map(|i| i.user_id).unwrap_or(0);
    if !state.app.is_admin(caller_id).await {
        warn!("[sio] remove-badge: user {} not authorized", caller_id);
        let _ = socket.emit("remove-badge-error", &json!({ "error": "Not authorized" }));
        return;
    }

    if let Err(e) = state.app.wdb.ingest_event("badges", "remove_badge", &json!({
        "userId": target_user_id,
        "badgeId": badge_id,
    })).await {
        warn!("[sio] remove-badge: failed: {}", e);
        let _ = socket.emit("remove-badge-error", &json!({ "error": "Failed to remove badge" }));
        return;
    }

    let badges = badges_json_for(state, target_user_id).await;
    drop(io.emit("user-badges-updated", &json!({
        "userId": format!("user-{}", target_user_id),
        "dbUserId": target_user_id,
        "badges": badges,
    })));
}
