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

/// Remove a board's version entry from the global map. Call when a
/// whiteboard channel is deleted so dead entries don't accumulate
/// forever (the map is insert-only otherwise).
pub(crate) fn remove_board_version(board_id: &str) {
    whiteboard_versions().lock().unwrap().remove(board_id);
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
        "meta": { "updatedAt": 0, "updatedBy": 0 },
    })
}

/// Apply the contract's load-time normalizations:
/// - missing `policy` → default `{ access: "open", writeAccess: "anyone" }`
/// - missing `elements`/`layers` → empty arrays
/// - unknown layer `blendMode` → `"source-over"`
fn normalize_document(mut doc: Value, board_id: &str) -> Value {
    if let Some(obj) = doc.as_object_mut() {
        obj.entry("boardId").or_insert_with(|| json!(board_id));
        obj.entry("elements").or_insert_with(|| json!([]));
        obj.entry("layers").or_insert_with(|| json!([]));
        if !obj.contains_key("policy") {
            obj.insert("policy".into(), json!({ "access": "open", "writeAccess": "anyone" }));
        }
        if let Some(layers) = obj.get_mut("layers").and_then(|l| l.as_array_mut()) {
            const KNOWN_BLEND_MODES: [&str; 10] = [
                "source-over", "multiply", "screen", "overlay", "darken",
                "lighten", "soft-light", "hard-light", "difference", "exclusion",
            ];
            for layer in layers {
                if let Some(l) = layer.as_object_mut() {
                    let mode = l.get("blendMode").and_then(|m| m.as_str()).unwrap_or("source-over");
                    if !KNOWN_BLEND_MODES.contains(&mode) {
                        l.insert("blendMode".into(), json!("source-over"));
                    }
                }
            }
        }
    }
    doc
}

fn doc_version(doc: &Value) -> u64 {
    doc.get("version").and_then(|v| v.as_u64()).unwrap_or(0)
}

fn authenticated_user_id(socket: &SocketRef, state: &SioState) -> i64 {
    if let Some(id) = socket.extensions.get::<SioIdentity>() {
        return id.user_id;
    }
    // Fallback for legacy connections without handshake identity.
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1)
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn on_whiteboard_join(socket: SocketRef, data: Value, state: SioState) {
    let board_id = match data.get("boardId").and_then(|v| v.as_str()) {
        Some(id) => id.trim().to_string(),
        None => {
            whiteboard_error(&socket, "UNAUTHORIZED", "Missing boardId");
            return;
        }
    };
    if board_id.is_empty() {
        whiteboard_error(&socket, "UNAUTHORIZED", "Missing boardId");
        return;
    }

    let user_id = authenticated_user_id(&socket, &state);
    if user_id <= 0 {
        whiteboard_error(&socket, "UNAUTHORIZED", "Authentication required");
        return;
    }

    if !can_access_channel(&state, user_id, &board_to_channel_id(&board_id)).await {
        whiteboard_error(&socket, "UNAUTHORIZED", "No channel membership");
        return;
    }

    // Load the persisted document, or fall back to a fresh default.
    let (document, version) = match state.app.wdb.get_whiteboard_doc(&board_id).await {
        Ok(Some(raw)) => match serde_json::from_str::<Value>(&raw) {
            Ok(doc) => {
                let v = doc_version(&doc);
                (doc, v)
            }
            Err(_) => (default_document(&board_id), 0),
        },
        Ok(None) => (default_document(&board_id), 0),
        Err(e) => {
            warn!("[whiteboard] load failed for {}: {}", board_id, e);
            whiteboard_error(&socket, "NOT_FOUND", "Failed to load board document");
            return;
        }
    };
    let document = normalize_document(document, &board_id);

    // Policy enforcement.
    let access = document
        .get("policy")
        .and_then(|p| p.get("access"))
        .and_then(|v| v.as_str())
        .unwrap_or("open");
    let write_access = document
        .get("policy")
        .and_then(|p| p.get("writeAccess"))
        .and_then(|v| v.as_str())
        .unwrap_or("anyone");
    let client_class = data.get("clientClass").and_then(|v| v.as_str()).unwrap_or("web");

    if access == "desktop_only" && client_class != "tauri" {
        whiteboard_error(&socket, "DESKTOP_REQUIRED", "This board is desktop-only");
        return;
    }

    let write = !(write_access == "desktop" && client_class != "tauri");

    let room = format!("wb:{}", board_id);
    let _ = socket.join(room);
    whiteboard_versions()
        .lock()
        .unwrap()
        .insert(board_id.clone(), version);

    let _ = socket.emit("whiteboard:joined", &json!({
        "boardId": board_id,
        "document": document,
        "capability": { "read": true, "write": write },
    }));
}

async fn on_whiteboard_leave(socket: SocketRef, data: Value, _state: SioState) {
    let board_id = match data.get("boardId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let room = format!("wb:{}", board_id);
    let _ = socket.leave(room);
    let _ = socket.emit("whiteboard:left", &json!({ "boardId": board_id }));
}

async fn on_whiteboard_snapshot(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let board_id = match data.get("boardId").and_then(|v| v.as_str()) {
        Some(id) => id.trim().to_string(),
        None => return,
    };
    if board_id.is_empty() {
        return;
    }
    let document = data.get("document").cloned().unwrap_or(json!(null));
    if !document.is_object() {
        return;
    }

    // Size check (2MB).
    let raw = serde_json::to_vec(&document).unwrap_or_default();
    if raw.len() > WHITEBOARD_MAX_DOCUMENT_BYTES {
        whiteboard_error(&socket, "PAYLOAD_TOO_LARGE", "Board document exceeds 2MB limit");
        return;
    }

    // Auth + membership.
    let user_id = authenticated_user_id(&socket, &state);
    if user_id <= 0 {
        whiteboard_error(&socket, "UNAUTHORIZED", "Authentication required");
        return;
    }
    if !can_access_channel(&state, user_id, &board_to_channel_id(&board_id)).await {
        whiteboard_error(&socket, "UNAUTHORIZED", "No channel membership");
        return;
    }

    // Version check against the server-owned map.
    let client_version = doc_version(&document);
    let current = current_version(&state, &board_id).await;
    if client_version != current {
        whiteboard_error(
            &socket,
            "VERSION_CONFLICT",
            &format!("Version mismatch: client {}, server {}", client_version, current),
        );
        return;
    }

    // Bump, persist, update map, fan out to the room except sender, ack sender.
    let new_version = client_version + 1;
    let mut doc = document;
    doc["version"] = json!(new_version);

    let serialized = serde_json::to_string(&doc).unwrap_or_default();
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
                .emit("whiteboard:snapshot", &json!({
                    "boardId": board_id,
                    "document": doc,
                }))
                .await;
            let _ = socket.emit("whiteboard:ack", &json!({
                "patchId": null,
                "version": new_version,
            }));
        }
        Err(e) => {
            warn!("[whiteboard] snapshot persist failed for {}: {}", board_id, e);
            whiteboard_error(&socket, "NOT_FOUND", "Failed to persist board document");
        }
    }
}

async fn on_whiteboard_patch(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let board_id = match data.get("boardId").and_then(|v| v.as_str()) {
        Some(id) => id.trim().to_string(),
        None => return,
    };
    if board_id.is_empty() {
        return;
    }
    let patch = data.get("patch").cloned().unwrap_or(json!(null));

    // Size check (128KB).
    let raw = serde_json::to_vec(&patch).unwrap_or_default();
    if raw.len() > WHITEBOARD_MAX_LIVE_PAYLOAD_BYTES {
        whiteboard_error(&socket, "PAYLOAD_TOO_LARGE", "Live payload exceeds 128KB limit");
        return;
    }

    // Auth + membership.
    let user_id = authenticated_user_id(&socket, &state);
    if user_id <= 0 {
        whiteboard_error(&socket, "UNAUTHORIZED", "Authentication required");
        return;
    }
    if !can_access_channel(&state, user_id, &board_to_channel_id(&board_id)).await {
        whiteboard_error(&socket, "UNAUTHORIZED", "No channel membership");
        return;
    }

    // A patch must carry an op.
    if patch.get("op").is_none() {
        whiteboard_error(&socket, "READ_ONLY", "Invalid patch: missing op");
        return;
    }

    let patch_id = patch
        .get("patchId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let room = format!("wb:{}", board_id);
    let _ = io
        .to(room)
        .except(socket.id.clone())
        .emit("whiteboard:patch", &json!({
            "boardId": board_id,
            "patch": patch,
        }))
        .await;

    let version = current_version(&state, &board_id).await;
    let _ = socket.emit("whiteboard:ack", &json!({
        "patchId": patch_id,
        "version": version,
    }));
}

async fn on_whiteboard_cursor(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let board_id = match data.get("boardId").and_then(|v| v.as_str()) {
        Some(id) => id.trim().to_string(),
        None => return,
    };
    if board_id.is_empty() {
        return;
    }
    let cursor = data.get("cursor").cloned().unwrap_or(json!(null));

    let raw = serde_json::to_vec(&cursor).unwrap_or_default();
    if raw.len() > WHITEBOARD_MAX_LIVE_PAYLOAD_BYTES {
        whiteboard_error(&socket, "PAYLOAD_TOO_LARGE", "Live payload exceeds 128KB limit");
        return;
    }

    // Cursors are ephemeral: drop silently if the socket is not authenticated.
    let user_id = authenticated_user_id(&socket, &state);
    if user_id <= 0 {
        return;
    }

    let username = data.get("username").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let color = data.get("color").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let room = format!("wb:{}", board_id);
    let _ = io
        .to(room)
        .except(socket.id.clone())
        .emit("whiteboard:cursor", &json!({
            "boardId": board_id,
            "cursor": cursor,
            "userId": format!("user-{}", user_id),
            "username": username,
            "color": color,
        }))
        .await;
}
