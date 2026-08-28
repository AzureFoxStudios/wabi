#[allow(dead_code)]
pub fn create_socket_layer(app: Arc<AppState>) -> SocketIoLayer {
    let app_for_broadcast = app.clone();
    let connected_users: ConnectedUsers = Arc::new(RwLock::new(HashMap::new()));
    // Publish the presence map so non-socket handlers (admin stats
    // "online now") can read it. Same OnceLock pattern as whiteboard_versions.
    publish_connected_users(connected_users.clone());
    let state = SioState {
        app,
        connected_users,
        voice_channels: Arc::new(RwLock::new(HashMap::new())),
        group_call_sessions: Arc::new(RwLock::new(HashMap::new())),
        breakout_rooms: Arc::new(RwLock::new(HashMap::new())),
    };

    // Spawn the periodic sweep task for stale Socket.IO state. Safety
    // net for on_disconnect failures. WABI_AUDIT_REPORT.md #3-#5.
    // JoinHandle is dropped — the task runs until process exit. Future
    // work: store in AppState for graceful shutdown.
    let _sweep_handle = spawn_sweep_loop(state.clone());

    let (layer, io) = SocketIo::builder().with_state(state).build_layer();
    // Keep a direct handle for HTTP routes that must broadcast immediately.
    if let Ok(mut handle) = app_for_broadcast.sio.try_write() {
        *handle = Some(io.clone());
    }

    io.ns(
        "/",
        |socket: SocketRef, Data(auth): Data<Value>, State(state): State<SioState>, io: SocketIo| {
            info!("[sio] connected: {}", socket.id);
            let token = auth.get("token").and_then(|v| v.as_str()).unwrap_or("").to_string();

            // Handshake-time JWT validation: reject invalid/expired tokens
            // before any handlers are registered. Valid tokens get a typed
            // SioIdentity extension so handlers never re-decode the JWT.
            if !token.is_empty() {
                match validate_token_sync(&token, &state.app.config.jwt_secret) {
                    Ok(identity) => {
                        socket.extensions.insert(identity);
                    }
                    Err(reason) => {
                        warn!("[sio] handshake auth failed for {}: {}", socket.id, reason);
                        let _ = socket.emit("auth-failed", &json!({ "reason": reason }));
                        let _ = socket.disconnect();
                        return;
                    }
                }
            }

            socket.extensions.insert(AuthToken(token));

            socket.on("join", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(username): Data<String>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_join(socket, username, s, io).await }
                }
            });

            socket.on("update-profile", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(cmd): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_update_profile(socket, cmd, s, io).await }
                }
            });

            // Legacy alias used by the profile-picture upload flow.
            socket.on("n", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(cmd): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_update_profile(socket, cmd, s, io).await }
                }
            });

            // Self-selected presence (active/away/busy/invisible). Invisible
            // broadcasts masked as "offline". Clients re-assert their stored
            // choice after every (re)connect via this same event.
            socket.on("set-presence", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_set_presence(socket, data, s, io).await }
                }
            });

            socket.on("rejoin", |socket: SocketRef, Data(_session_id): Data<String>| async move {
                let _ = socket.emit("rejoin-failed", &json!({ "reason": "sessions not persisted" }));
            });

            socket.on("join-channel", {
                let s = state.clone();
                move |socket: SocketRef, Data(channel_id): Data<String>| {
                    let s = s.clone();
                    async move { on_join_channel(socket, channel_id, s).await }
                }
            });

            socket.on("message", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(cmd): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_message(socket, cmd, s, io).await }
                }
            });

            socket.on("load-history", {
                let s = state.clone();
                move |socket: SocketRef, Data(req): Data<Value>| {
                    let s = s.clone();
                    async move { on_load_history(socket, req, s).await }
                }
            });

            socket.on("delete-message", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(cmd): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_delete_message(socket, cmd, s, io).await }
                }
            });

            socket.on("typing", {
                let s = state.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    async move { on_typing(socket, data, s).await }
                }
            });

            socket.on("clear-channel-messages", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(cmd): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_clear_channel_messages(socket, cmd, s, io).await }
                }
            });

            socket.on("voice-channel-join", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_voice_channel_join(socket, data, s, io).await }
                }
            });

            socket.on("voice-channel-subscribe", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_voice_channel_subscribe(socket, data, s, io).await }
                }
            });

            socket.on("voice-channel-unsubscribe", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_voice_channel_unsubscribe(socket, data, s, io).await }
                }
            });

            socket.on("voice-channel-leave", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_voice_channel_leave(socket, data, s, io).await }
                }
            });

            socket.on("voice-channel-kick", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_voice_channel_kick(socket, data, s, io).await }
                }
            });

            socket.on("set-voice-transmit-mode", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_set_voice_transmit_mode(socket, data, s, io).await }
                }
            });

            socket.on("voice-self-state", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_voice_self_state(socket, data, s, io).await }
                }
            });

            socket.on("call-initiate", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_call_initiate(socket, data, s, io).await }
                }
            });

            socket.on("call-answer", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_call_answer(socket, data, s, io).await }
                }
            });

            socket.on("call-reject", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_call_reject(socket, data, s, io).await }
                }
            });

            socket.on("call-cancel", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_call_cancel(socket, data, s, io).await }
                }
            });

            socket.on("call-end", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_call_end(socket, data, s, io).await }
                }
            });

            socket.on("group-call-leave", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_group_call_leave(socket, data, s, io).await }
                }
            });

            socket.on("group-call-stop-ringing", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_group_call_stop_ringing(socket, data, s, io).await }
                }
            });

            socket.on("create-dm", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_create_dm(socket, data, s, io).await }
                }
            });

            socket.on("create-group", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_create_group(socket, data, s, io).await }
                }
            });

            socket.on("delete-dm", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_delete_dm(socket, data, s, io).await }
                }
            });

            socket.on("ban-user", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_ban_user(socket, data, s, io).await }
                }
            });

            socket.on("voice-mute", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_voice_mute(socket, data, s, io).await }
                }
            });

            socket.on("voice-unmute", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_voice_unmute(socket, data, s, io).await }
                }
            });

            socket.on("voice-deafen", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_voice_deafen(socket, data, s, io).await }
                }
            });

            socket.on("voice-undeafen", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_voice_undeafen(socket, data, s, io).await }
                }
            });

            socket.on("kick-group-member", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_kick_group_member(socket, data, s, io).await }
                }
            });

            socket.on("leave-group", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_leave_group(socket, data, s, io).await }
                }
            });

            socket.on("add-group-member", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_add_group_member(socket, data, s, io).await }
                }
            });

            socket.on("update-group-avatar", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_update_group_avatar(socket, data, s, io).await }
                }
            });

            socket.on("edit-message", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_edit_message(socket, data, s, io).await }
                }
            });

            socket.on("toggle-pin-message", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_toggle_pin(socket, data, s, io).await }
                }
            });

            // Calling diagnostics RTT echo for the wabidb relay transport
            // (2026-08-27): the client stamps {t} and measures the round
            // trip on `wabidb-pong`. Stateless by design — no DB/state IO.
            socket.on("wabidb-ping", {
                move |socket: SocketRef, Data(data): Data<Value>| {

                    let _ = socket.emit("wabidb-pong", &data);


                }
            });

            socket.on("call-offer", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_call_offer(socket, data, s, io).await }
                }
            });

            socket.on("call-answer-sdp", {
                let io = io.clone();
                let app = state.app.clone();
                let s = state.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let my_stable = get_my_stable_id(&socket, &app.config.jwt_secret);
                    let target_id = data.get("targetId").and_then(|v| v.as_str()).map(String::from);
                    let answer = data.get("answer").cloned();
                    let io = io.clone();
                    async move {
                        if let (Some(target), Some(ans)) = (target_id, answer) {
                            // SEC-3: answers only flow within a call relationship.
                            if !signaling_consent(&s, &socket, &target).await {
                                warn!("[sio] call-answer-sdp consent denied: socket {} ({}) -> {}", socket.id, my_stable, target);
                                return;
                            }
                            let _ = io.to(target).emit("call-answer-sdp", &json!({ "answer": ans, "senderId": my_stable })).await;
                        }
                    }
                }
            });

            socket.on("call-ice-candidate", {
                let io = io.clone();
                let app = state.app.clone();
                let s = state.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let my_stable = get_my_stable_id(&socket, &app.config.jwt_secret);
                    let target_id = data.get("targetId").and_then(|v| v.as_str()).map(String::from);
                    let candidate = data.get("candidate").cloned();
                    let io = io.clone();
                    async move {
                        if let (Some(target), Some(cand)) = (target_id, candidate) {
                            // SEC-3: ICE candidates only flow within a call relationship.
                            if !signaling_consent(&s, &socket, &target).await {
                                warn!("[sio] call-ice-candidate consent denied: socket {} ({}) -> {}", socket.id, my_stable, target);
                                return;
                            }
                            let _ = io.to(target).emit("call-ice-candidate", &json!({ "candidate": cand, "senderId": my_stable })).await;
                        }
                    }
                }
            });

            socket.on("get-emojis", {
                let s = state.clone();
                move |socket: SocketRef| {
                    let s = s.clone();
                    async move { handle_get_emojis(socket, &s).await }
                }
            });

            socket.on("delete-emoji", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { handle_delete_emoji(socket, data, &s, &io).await }
                }
            });

            socket.on("add-emoji-reaction", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_add_emoji_reaction(socket, data, s, io).await }
                }
            });

            socket.on("remove-emoji-reaction", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_remove_emoji_reaction(socket, data, s, io).await }
                }
            });

            socket.on("get-role-definitions", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef| {
                    let s = s.clone(); let io = io.clone();
                    async move { handle_get_role_definitions(socket, &io, &s).await }
                }
            });

            socket.on("assign-role", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { handle_assign_role(socket, data, &s, &io).await }
                }
            });

            socket.on("toggle-reception", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { handle_toggle_reception(socket, data, &s, &io).await }
                }
            });

            socket.on("remove-role", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { handle_remove_role(socket, data, &s, &io).await }
                }
            });

            socket.on("get-badge-catalog", {
                let s = state.clone();
                move |socket: SocketRef| {
                    let s = s.clone();
                    async move { handle_get_badge_catalog(socket, &s).await }
                }
            });

            socket.on("assign-badge", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { handle_assign_badge(socket, data, &s, &io).await }
                }
            });

            socket.on("remove-badge", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { handle_remove_badge(socket, data, &s, &io).await }
                }
            });

            socket.on("update-channel-settings", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { handle_update_channel_settings(socket, data, &s, &io).await }
                }
            });

            socket.on("set-role-display-name", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { handle_set_role_display_name(socket, data, &s, &io).await }
                }
            });

            socket.on("join-wabidb-call", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_join_wabidb_call(socket, data, s, io).await }
                }
            });

            socket.on("wabidb-media", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_wabidb_media(socket, data, s, io).await }
                }
            });

            socket.on("start-screen-share", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_start_screen_share(socket, s, io).await }
                }
            });

            socket.on("stop-screen-share", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_stop_screen_share(socket, s, io).await }
                }
            });

            // The client awaits the ack with a 4s timeout (old servers never
            // ack; recording proceeds locally either way).
            socket.on("call-recording-set-active", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>, ack: AckSender| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_call_recording_set_active(socket, data, s, io, ack).await }
                }
            });

            socket.on("webrtc-offer", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_webrtc_offer(socket, data, s, io).await }
                }
            });

            socket.on("webrtc-answer", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_webrtc_answer(socket, data, s, io).await }
                }
            });

            socket.on("webrtc-ice-candidate", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_webrtc_ice_candidate(socket, data, s, io).await }
                }
            });

            socket.on("p2p-offer", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_p2p_offer(socket, data, s, io).await }
                }
            });

            socket.on("p2p-answer", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_p2p_answer(socket, data, s, io).await }
                }
            });

            socket.on("p2p-ice-candidate", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_p2p_ice_candidate(socket, data, s, io).await }
                }
            });

            socket.on("create-thread", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_create_thread(socket, data, s, io).await }
                }
            });

            socket.on("pin-channel", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_pin_channel(socket, data, s, io).await }
                }
            });

            socket.on("unpin-channel", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_unpin_channel(socket, data, s, io).await }
                }
            });

            socket.on("reorder-channels", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_reorder_channels(socket, data, s, io).await }
                }
            });

            socket.on("retry-message", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_retry_message(socket, data, s, io).await }
                }
            });

            socket.on("mark-messages-as-read", {
                let s = state.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    async move { on_mark_messages_as_read(socket, data, s).await }
                }
            });

            socket.on("mark-channel-as-read", {
                let s = state.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    async move { on_mark_channel_as_read(socket, data, s).await }
                }
            });

            socket.on("sync-newer", {
                let s = state.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    async move { on_sync_newer(socket, data, s).await }
                }
            });

            socket.on("create-breakout-rooms", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_create_breakout_rooms(socket, data, s, io).await }
                }
            });

            socket.on("close-breakout-rooms", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_close_breakout_rooms(socket, data, s, io).await }
                }
            });

            socket.on("move-user-to-breakout", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_move_user_to_breakout(socket, data, s, io).await }
                }
            });

            socket.on("move-user-to-voice-channel", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_move_user_to_voice_channel(socket, data, s, io).await }
                }
            });

            socket.on("whiteboard:join", {
                let s = state.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    async move { on_whiteboard_join(socket, data, s).await }
                }
            });

            socket.on("whiteboard:leave", {
                let s = state.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    async move { on_whiteboard_leave(socket, data, s).await }
                }
            });

            socket.on("whiteboard:snapshot", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_whiteboard_snapshot(socket, data, s, io).await }
                }
            });

            socket.on("whiteboard:patch", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_whiteboard_patch(socket, data, s, io).await }
                }
            });

            socket.on("whiteboard:cursor", {
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_whiteboard_cursor(socket, data, s, io).await }
                }
            });

            socket.on_disconnect({
                let s = state.clone(); let io = io.clone();
                move |socket: SocketRef, _reason: socketioxide::socket::DisconnectReason| {
                    let s = s.clone(); let io = io.clone();
                    async move { on_disconnect(socket, s, io).await }
                }
            });
        },
    );

    layer
}
