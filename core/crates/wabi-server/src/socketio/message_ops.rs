// WDB-compat shim.

#[allow(dead_code)]
async fn on_retry_message(socket: SocketRef, data: Value, _state: SioState, _io: SocketIo) {
    // No persisted original command or restart-safe deduplication contract
    // exists for this legacy action. An echo was never a persistence retry.
    let _ = socket.emit("retry-message-error", &json!({
        "channelId": data.get("channelId").and_then(Value::as_str),
        "messageId": data.get("messageId").and_then(Value::as_str),
        "code": "unsupported",
        "error": "Persistence retry is unavailable. Check history before sending again.",
    }));
}

#[allow(dead_code)]
async fn on_mark_messages_as_read(socket: SocketRef, _data: Value, _state: SioState) {
    let _ = socket.emit("messages-read-ack", &json!({}));
}

#[allow(dead_code)]
async fn on_mark_channel_as_read(socket: SocketRef, data: Value, _state: SioState) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let _ = socket.emit("channel-read-ack", &json!({"channelId": channel_id}));
}

#[allow(dead_code)]
async fn on_sync_newer(socket: SocketRef, data: Value, state: SioState) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    if require_socket_channel(&socket, &state, &channel_id, "sync-error").await.is_none() { return; }
    let msgs: Vec<Value> = {
        let session = state.app.session_messages.read().await;
        session.get(&channel_id).cloned().unwrap_or_default()
    };
    let _ = socket.emit("sync-newer-result", &json!({
        "channelId": channel_id,
        "messages": msgs,
    }));
}
