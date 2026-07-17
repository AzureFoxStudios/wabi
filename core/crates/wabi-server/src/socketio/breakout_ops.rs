// WDB-compat shim.

#[allow(dead_code)]
async fn on_create_breakout_rooms(socket: SocketRef, _data: Value, _state: SioState, _io: SocketIo) {
    warn!("[sio] create-breakout-rooms not yet implemented");
    let _ = socket.emit("breakout-rooms-error", &json!({"error": "not yet implemented"}));
}

#[allow(dead_code)]
async fn on_close_breakout_rooms(socket: SocketRef, _data: Value, _state: SioState, _io: SocketIo) {
    warn!("[sio] close-breakout-rooms not yet implemented");
    let _ = socket.emit("breakout-rooms-error", &json!({"error": "not yet implemented"}));
}

#[allow(dead_code)]
async fn on_move_user_to_breakout(socket: SocketRef, _data: Value, _state: SioState, _io: SocketIo) {
    warn!("[sio] move-user-to-breakout not yet implemented");
    let _ = socket.emit("breakout-rooms-error", &json!({"error": "not yet implemented"}));
}

#[allow(dead_code)]
async fn on_move_user_to_voice_channel(socket: SocketRef, _data: Value, _state: SioState, _io: SocketIo) {
    warn!("[sio] move-user-to-voice-channel not yet implemented");
    let _ = socket.emit("move-user-to-voice-channel-error", &json!({"error": "not yet implemented"}));
}
