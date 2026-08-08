// Whiteboard socket handlers — implements the whiteboard wire contract
// (docs/plans/2026-08-08-whiteboard-wire-contract.md).
//
// - whiteboard:join      → load doc, enforce policy, join room wb:<boardId>
// - whiteboard:leave      → leave room
// - whiteboard:snapshot   → size + version check, persist, fan out, ack
// - whiteboard:patch      → size + op check, fan out (except sender), ack
// - whiteboard:cursor     → ephemeral fan out (except sender)

use crate::api::whiteboard::{WHITEBOARD_MAX_DOCUMENT_BYTES, WHITEBOARD_MAX_LIVE_PAYLOAD_BYTES};
use std::sync::{Mutex, OnceLock};

// ---------------------------------------------------------------------------
// Server-owned per-board version map
// ---------------------------------------------------------------------------
//
// The server owns version truth: every persisted snapshot bumps the version
// and the new version is communicated back to the sender (via
// `whiteboard:ack`) and to other room members (via the fan-out document).
// Clients echo the version the server last told them. The map is in-memory
// (lost on restart); on a missing entry we fall back to the persisted doc's
// version so post-restart saves still validate correctly.

static WHITEBOARD_VERSIONS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

/// Access the server-owned per-board version map. Shared with the REST
/// board-document handler so PUT and socket snapshot agree on the current
/// version.
pub(crate) fn whiteboard_versions() -> &'static Mutex<HashMap<String, u64>> {
    WHITEBOARD_VERSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resolve the current version for a board: in-memory map first, then the
/// persisted document, else 0 (fresh board).
async fn current_version(state: &SioState, board_id: &str) -> u64 {
    if let Some(v) = whiteboard_versions().lock().unwrap().get(board_id) {
        return *v;
    }
    match state.app.wdb.get_whiteboard_doc(board_id).await {
        Ok(Some(doc)) => serde_json::from_str::<Value>(&doc)
            .ok()
            .and_then(|d| d.get("version").and_then(|v| v.as_u64()))
            .unwrap_or(0),
        _ => 0,
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn whiteboard_error(socket: &SocketRef, code: &str, message: &str) {
    let _ = socket.emit("whiteboard:error", &json!({ "code": code, "message": message }));
}

/// Board ids are `channel:<uuid>`. Strip the prefix to check channel membership.
fn board_to_channel_id(board_id: &str) -> String {
    board_id.strip_prefix("channel:").unwrap_or(board_id).to_string()
}

/// Socket-side membership: owner/admins bypass, otherwise the board's channel
/// must be in the user's channel list.
async fn can_access_channel(state: &SioState, user_id: i64, channel_id: &str) -> bool {
    if state.app.is_owner(user_id).await || state.app.is_admin(user_id).await {
        return true;
    }
    match state.app.wdb.list_channels(Some(user_id as u64)).await {
        Ok(channels) => channels.iter().any(|c| c.channel_id == channel_id),
        Err(_) => false,
    }
}

/// Default document for a board that has never been saved.
fn default_document(board_id: &str) -> Value {
    json!({
        "boardId": board_id,
        "version": 0,
        "elements": [],
        "layers": [],
        "activeLayerId": "layer-default",
        "viewport": { "x": 0, "y": 0, "zoom": 1 },
        "policy": { "access": "open", "writeAccess": "anyone" },
        "meta": { "updatedAt": 0, "updatedBy": null }
    })
}

const VALID_BLEND_MODES: &[&str] = &[
    "source-over",
    "multiply",
    "screen",
    "overlay",
    "darken",
    "lighten",
];

/// Ensure a document matches the contract shape: canonical boardId, required
/// collections, valid policy, valid layer blend modes. Missing keys are
/// defaulted, never removed.
fn normalize_document(mut doc: Value, board_id: &str) -> Value {
    if !doc.is_object() {
        doc = json!({});
    }
    let obj = doc.as_object_mut().unwrap();
    obj.entry("boardId").or_insert_with(|| json!(board_id));
    obj.entry("elements").or_insert_with(|| json!([]));
    obj.entry("layers").or_insert_with(|| json!([]));
    obj.entry("activeLayerId").or_insert_with(|| json!("layer-default"));
    obj.entry("viewport").or_insert_with(|| json!({ "x": 0, "y": 0, "zoom": 1 }));
    let policy = obj
        .entry("policy")
        .or_insert_with(|| json!({ "access": "open", "writeAccess": "anyone" }));
    if let Some(p) = policy.as_object_mut() {
        p.entry("access").or_insert_with(|| json!("open"));
        p.entry("writeAccess").or_insert_with(|| json!("anyone"));
    }
    if let Some(layers) = obj.get_mut("layers").and_then(|l| l.as_array_mut()) {
        for layer in layers.iter_mut() {
            let valid = layer
                .get("blendMode")
                .and_then(|b| b.as_str())
                .map(|b| VALID_BLEND_MODES.contains(&b))
                .unwrap_or(false);
            if !valid {
                layer["blendMode"] = json!("source-over");
            }
        }
    }
    doc
}

fn doc_version(doc: &Value) -> u64 {
    doc.get("version").and_then(|v| v.as_u64()).unwrap_or(0)
}

fn authenticated_user_id(socket: &SocketRef, state: &SioState) -> i64 {
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1)
}

/// True when the socket advertises the Tauri desktop client (via clientClass).
fn is_tauri_client(data: &Value) -> bool {
    data.get("clientClass").and_then(|v| v.as_str()) == Some("tauri")
        || data.get("clientType").and_then(|v| v.as_str()) == Some("tauri")
        || data.get("isTauri").and_then(|v| v.as_bool()) == Some(true)
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn on_whiteboard_join(socket: SocketRef, data: Value, state: SioState) {
    let board_id = match data
        .get("boardId")
        .or_else(|| data.get("channelId"))
        .and_then(|v| v.as_str())
    {
        Some(id) => id.trim().to_string(),
        None => {
            whiteboard_error(&socket, "UNAUTHORIZED", "Missing boardId");
            return;
        }
    };
    if board_id.is_empty() {
        whiteboard_error(&socket, "UNAUTHORIZED", "Invalid boardId");
        return;
    }

    let user_id = authenticated_user_id(&socket, &state);
    if user_id <= 0 {
        whiteboard_error(&socket, "UNAUTHORIZED", "Authentication required");
        return;
    }

    let channel_id = board_to_channel_id(&board_id);
    if !can_access_channel(&state, user_id, &channel_id).await {
        whiteboard_error(&socket, "UNAUTHORIZED", "Not a member of this channel");
        return;
    }

    let document = match state.app.wdb.get_whiteboard_doc(&board_id).await {
        Ok(Some(doc)) => serde_json::from_str::<Value>(&doc).unwrap_or_else(|_| default_document(&board_id)),
        Ok(None) => default_document(&board_id),
        Err(e) => {
            warn!("[whiteboard] join load failed: {}", e);
            whiteboard_error(&socket, "UNAUTHORIZED", "Failed to load board");
            return;
        }
    };
    let document = normalize_document(document, &board_id);

    let is_tauri = is_tauri_client(&data);
    let policy = document.get("policy").cloned().unwrap_or_default();
    let access = policy.get("access").and_then(|v| v.as_str()).unwrap_or("open");
    let write_access = policy
        .get("writeAccess")
        .and_then(|v| v.as_str())
        .unwrap_or("anyone");

    if access == "desktop_only" && !is_tauri {
        whiteboard_error(&socket, "DESKTOP_REQUIRED", "This board is desktop only");
        return;
    }

    let write = match write_access {
        "desktop" => is_tauri,
        _ => true,
    };

    let version = doc_version(&document);
    whiteboard_versions()
        .lock()
        .unwrap()
        .insert(board_id.clone(), version);

    let room = format!("wb:{}", board_id);
    socket.join(room);

    let _ = socket.emit(
        "whiteboard:joined",
        &json!({
            "boardId": board_id,
            "document": document,
            "capability": {
                "write": write,
                "readOnly": !write,
                "reason": if write { Value::Null } else { json!("desktop-write-required") }
            }
        }),
    );
}

async fn on_whiteboard_leave(socket: SocketRef, data: Value, _state: SioState) {
    let board_id = match data.get("boardId").and_then(|v| v.as_str()) {
        Some(id) => id.trim().to_string(),
        None => return,
    };
    if board_id.is_empty() {
        return;
    }
    let room = format!("wb:{}", board_id);
    socket.leave(room);
    let _ = socket.emit("whiteboard:left", &json!({ "boardId": board_id }));
}

async fn on_whiteboard_snapshot(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let board_id = match data.get("boardId").and_then(|v| v.as_str()) {
        Some(id) => id.trim().to_string(),
        None => {
            whiteboard_error(&socket, "UNAUTHORIZED", "Missing boardId");
            return;
        }
    };
    if board_id.is_empty() {
        whiteboard_error(&socket, "UNAUTHORIZED", "Invalid boardId");
        return;
    }

    let raw_doc = data.get("document").cloned().unwrap_or(json!({}));
    if serde_json::to_vec(&raw_doc).map(|b| b.len()).unwrap_or(0) > WHITEBOARD_MAX_DOCUMENT_BYTES {
        whiteboard_error(&socket, "PAYLOAD_TOO_LARGE", "Board document exceeds 2MB limit");
        return;
    }

    let user_id = authenticated_user_id(&socket, &state);
    if user_id <= 0 {
        whiteboard_error(&socket, "UNAUTHORIZED", "Authentication required");
        return;
    }

    let channel_id = board_to_channel_id(&board_id);
    if !can_access_channel(&state, user_id, &channel_id).await {
        whiteboard_error(&socket, "UNAUTHORIZED", "Not a member of this channel");
        return;
    }

    let client_version = doc_version(&raw_doc);
    let current = current_version(&state, &board_id).await;
    if client_version != current {
        whiteboard_error(
            &socket,
            "VERSION_CONFLICT",
            &format!("Version mismatch: client {}, server {}", client_version, current),
        );
        return;
    }

    let new_version = client_version + 1;
    let mut document = normalize_document(raw_doc, &board_id);
    document["version"] = json!(new_version);
    document["boardId"] = json!(board_id);
    let serialized = serde_json::to_string(&document).unwrap_or_default();

    match state.app.wdb.put_whiteboard_doc(&board_id, &serialized).await {
        Ok(()) => {
            whiteboard_versions()
                .lock()
                .unwrap()
                .insert(board_id.clone(), new_version);

            let room = format!("wb:{}", board_id);
            let _ = io
                .to(room)
                .except(socket.id.clone())
                .emit(
                    "whiteboard:snapshot",
                    &json!({ "boardId": board_id, "document": document }),
                )
                .await;

            let _ = socket.emit(
                "whiteboard:ack",
                &json!({ "patchId": null, "version": new_version }),
            );
        }
        Err(e) => {
            warn!("[whiteboard] snapshot persist failed: {}", e);
            whiteboard_error(&socket, "UNAUTHORIZED", "Failed to persist board");
        }
    }
}

async fn on_whiteboard_patch(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let board_id = match data.get("boardId").and_then(|v| v.as_str()) {
        Some(id) => id.trim().to_string(),
        None => {
            whiteboard_error(&socket, "UNAUTHORIZED", "Missing boardId");
            return;
        }
    };
    if board_id.is_empty() {
        whiteboard_error(&socket, "UNAUTHORIZED", "Invalid boardId");
        return;
    }

    let patch = data.get("patch").cloned().unwrap_or(json!({}));
    if serde_json::to_vec(&patch).map(|b| b.len()).unwrap_or(0) > WHITEBOARD_MAX_LIVE_PAYLOAD_BYTES {
        whiteboard_error(&socket, "PAYLOAD_TOO_LARGE", "Patch exceeds 128KB limit");
        return;
    }

    let user_id = authenticated_user_id(&socket, &state);
    if user_id <= 0 {
        whiteboard_error(&socket, "UNAUTHORIZED", "Authentication required");
        return;
    }

    let channel_id = board_to_channel_id(&board_id);
    if !can_access_channel(&state, user_id, &channel_id).await {
        whiteboard_error(&socket, "UNAUTHORIZED", "Not a member of this channel");
        return;
    }

    if patch.get("op").is_none() {
        whiteboard_error(&socket, "READ_ONLY", "Patch missing required op field");
        return;
    }

    let patch_id = data
        .get("patchId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let version = current_version(&state, &board_id).await;

    let room = format!("wb:{}", board_id);
    let _ = io
        .to(room)
        .except(socket.id.clone())
        .emit(
            "whiteboard:patch",
            &json!({
                "boardId": board_id,
                "patch": patch,
                "patchId": patch_id,
                "userId": format!("user-{}", user_id),
                "sentAt": now_micros(),
            }),
        )
        .await;

    let _ = socket.emit(
        "whiteboard:ack",
        &json!({ "patchId": patch_id, "version": version }),
    );
}

async fn on_whiteboard_cursor(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let board_id = match data.get("boardId").and_then(|v| v.as_str()) {
        Some(id) => id.trim().to_string(),
        None => return,
    };
    if board_id.is_empty() {
        return;
    }

    let cursor = data.get("cursor").cloned().unwrap_or(json!({}));
    if serde_json::to_vec(&cursor).map(|b| b.len()).unwrap_or(0) > WHITEBOARD_MAX_LIVE_PAYLOAD_BYTES {
        return;
    }

    let user_id = authenticated_user_id(&socket, &state);
    if user_id <= 0 {
        return;
    }

    let username = data
        .get("username")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let color = data
        .get("color")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let room = format!("wb:{}", board_id);
    let _ = io
        .to(room)
        .except(socket.id.clone())
        .emit(
            "whiteboard:cursor",
            &json!({
                "boardId": board_id,
                "cursor": cursor,
                "userId": format!("user-{}", user_id),
                "username": username,
                "color": color,
            }),
        )
        .await;
}
