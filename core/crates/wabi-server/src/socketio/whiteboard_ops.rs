// WDB-compat shim.

#[allow(dead_code)]
async fn on_whiteboard_join(socket: SocketRef, data: Value, _state: SioState) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let room = format!("wb:{}", channel_id);
    let _ = socket.join(room);
    let _ = socket.emit("whiteboard:joined", &json!({"channelId": channel_id}));
}

#[allow(dead_code)]
async fn on_whiteboard_leave(socket: SocketRef, data: Value, _state: SioState) {
    let board_id = match data.get("boardId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let room = format!("wb:{}", board_id);
    let _ = socket.leave(room);
    let _ = socket.emit("whiteboard:left", &json!({"boardId": board_id}));
}

#[allow(dead_code)]
async fn on_whiteboard_snapshot(_socket: SocketRef, data: Value, _state: SioState, io: SocketIo) {
    let board_id = match data.get("boardId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let document = data.get("document").cloned().unwrap_or(json!(null));
    let room = format!("wb:{}", board_id);
    let _ = io.to(room).emit("whiteboard:snapshot", &json!({
        "boardId": board_id,
        "document": document,
    })).await;
}

#[allow(dead_code)]
async fn on_whiteboard_patch(socket: SocketRef, data: Value, _state: SioState, io: SocketIo) {
    let board_id = match data.get("boardId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let patch = data.get("patch").cloned().unwrap_or(json!(null));
    let room = format!("wb:{}", board_id);
    let _ = io.to(room).except(socket.id.clone()).emit("whiteboard:patch", &json!({
        "boardId": board_id,
        "patch": patch,
    })).await;
}

#[allow(dead_code)]
async fn on_whiteboard_cursor(socket: SocketRef, data: Value, _state: SioState, io: SocketIo) {
    let board_id = match data.get("boardId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let cursor = data.get("cursor").cloned().unwrap_or(json!(null));
    let room = format!("wb:{}", board_id);
    let _ = io.to(room).except(socket.id.clone()).emit("whiteboard:cursor", &json!({
        "boardId": board_id,
        "cursor": cursor,
    })).await;
}
