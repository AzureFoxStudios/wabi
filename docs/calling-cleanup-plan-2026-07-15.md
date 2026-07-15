# Wabi Calling Cleanup & Offline Resilience — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement task-by-task.

**Goal:** Make all calling surfaces (DM calls, group calls, voice channels, TeamSpeak-style multi-listen) reliably work end-to-end, and ensure calling degrades gracefully when the internet is out but the wabi server is reachable on localhost/LAN.

**Architecture:** Wabi's calling has 3 transport tiers (wabidb relay default, P2P opt-in, LiveKit SFU admin opt-in). Call signaling flows through Socket.IO. Call session state is persisted via WabiDB. Voice channels use a join/subscribe model where join = transmitting audio and subscribe = listening only (TeamSpeak-style multi-listen). The offline concern is not a new transport — the server binds 0.0.0.0 so localhost/LAN always works; the issue is that calling code makes external network checks (TURN/STUN, LiveKit reachability) that fail when the internet is out, causing calls to fail even though the socket connection to the local server is still alive.

**Tech Stack:** SvelteKit frontend, Socket.IO (socket.io-client), wabi-server (Rust, Axum, socketioxide), WabiDB (Rust engine), LiveKit (optional SFU).

---

## AUDIT SUMMARY: What's Already Done vs What's Broken

### Already done (per CALLING_AUDIT_FIXES.md):
- B1: UnknownStreamKey fix for WabiDB call commands
- B2: WS mount path /ws/ws → /ws fix
- B3: CallParticipantsProjection registers call_participant_left
- F1: DM/group call socket listeners wired in socketConnectionCore.ts
- F2: call-ice-candidate listener added
- F3: wabidbMediaRelay decode pipeline rewritten (opus-recorder WASM)
- F4: wabidb/'stdb' branch added to joinVoiceChannel
- F5: storefwd playback field aligned to audioBase64
- F6: connectWabidbCall stores userId, calls joinSession
- F7: media-gateway idle/ready typo fixed
- R1-R4: Recording fixes (AudioContext resume, empty-stream guard, container match)
- Offline Layer 1 (Boot Survival): wabi_has_logged_in flag, reconnect boot shell, "Work Offline" button, retry logic

### Known gaps (from CALLING_AUDIT_FIXES.md "Out of scope"):
- No live two-client end-to-end smoke test
- Tauri save_call_recording command not registered (R2)

### NEW gaps found in this audit (this plan addresses):

#### G1: voice-channel-subscribe backend bug (CRITICAL — breaks TeamSpeak multi-join)
`wiring.rs:95` maps `voice-channel-subscribe` to `on_voice_channel_join` — the SAME handler as `voice-channel-join`. This means subscribing to listen to a second channel triggers a full join (creates a participant entry, pushes state, etc.) instead of a listen-only subscription. There is NO `on_voice_channel_subscribe` handler. The `addVoiceChannelListen` / `removeVoiceChannelListen` frontend functions exist and work correctly, but the backend treats subscribe = join.

#### G2: No voice-channel-unsubscribe backend handler
`wiring.rs` has no handler for `voice-channel-unsubscribe` at all. The frontend `removeVoiceChannelListen` emits it but the server silently drops it. Users can never stop listening to a channel.

#### G3: Calling code has no offline/localhost awareness
When the internet is out:
- `prefetchTurnCredentials()` in startCall/joinVoiceChannel/startGroupCall hits external TURN servers → fails → call fails
- `resolveActiveTransport()` calls `syncMediaRuntimeFromServer()` which may hit external LiveKit URLs → fails → fallback may produce wrong transport
- `resolveCallTransportPlan()` checks `gatewayHealthy` via external reachability → may report unhealthy when the local server is fine
If the user is on the same network as the wabi server (localhost or LAN), the Socket.IO socket is still connected, but calling fails because the transport resolution path makes external network assumptions.

#### G4: No offline-mode indicator in calling UI
If the user is in offline/Work Offline mode, there's no visual indication that calling is limited to local-network users. Users see the normal call UI and only discover it's broken when a call fails.

#### G5: Settings.svelte doesn't clear wabi_has_logged_in on explicit logout
The offline architecture doc says Settings should `localStorage.removeItem('wabi_has_logged_in')` on explicit logout. The +page.svelte does it in the setupRequired branch and the fresh-user branch, but the actual logout button in Settings doesn't clear it. A user who logs out and then goes offline would be stuck in reconnect mode instead of seeing login.

---

## TASKS

### Task 1: Fix voice-channel-subscribe backend — CREATE dedicated subscribe handler

**Objective:** Server distinguishes subscribe (listen-only) from join (transmit+listen). Subscribing adds the user to the channel's listener list without creating a participant entry or pushing voice-channel-joined events.

**Files:**
- Modify: `core/crates/wabi-server/src/socketio/voice_channels.rs`
- Modify: `core/crates/wabi-server/src/socketio/wiring.rs`

**Step 1: Write failing test**

Create or add to voice_channels test:
```rust
// In voice_channels test module
#[tokio::test]
async fn test_subscribe_does_not_create_participant() {
    let (state, _io) = setup_test_state().await;
    // Simulate subscribe
    on_voice_channel_subscribe(test_socket(), json!({"channelId": "ch1"}), state.clone(), test_io()).await;
    // Assert: voice_channels map has ch1 with the user in listeners but NOT in participants
    let voice = state.voice_channels.read().await;
    let channel = voice.get("ch1").expect("channel should exist");
    assert!(channel.listeners.contains(&user_id));
    assert!(!channel.participants.contains(&user_id));
}
```

**Step 2: Run test to verify failure**

Run: `cargo test -p wabi-server --lib voice_channels -- --nocapture`
Expected: FAIL — `on_voice_channel_subscribe` not defined

**Step 3: Implement on_voice_channel_subscribe**

Add to `voice_channels.rs`:
```rust
async fn on_voice_channel_subscribe(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = data.get("channelId")
        .and_then(|v| v.as_str())
        .unwrap_or("").to_string();
    if channel_id.is_empty() { return; }

    let user_id = match extract_user_id(&socket, &state) {
        Some(id) => id,
        None => return,
    };

    {
        let mut voice = state.voice_channels.write().await;
        let entry = voice.entry(channel_id.clone())
            .or_insert_with(|| VoiceChannelState::default());
        if !entry.listeners.contains(&user_id) {
            entry.listeners.push(user_id);
        }
    }

    // Send current channel state to the subscriber (who's in the channel)
    let voice = state.voice_channels.read().await;
    if let Some(entry) = voice.get(&channel_id) {
        let _ = socket.emit("voice-channel-state", &json!({
            "channelId": channel_id,
            "members": entry.participants.iter().map(|uid| {
                json!({ "userId": uid.to_string(), "username": lookup_username(uid, &state) })
            }).collect::<Vec<_>>()
        }));
    }
}
```

Also add `on_voice_channel_unsubscribe`:
```rust
async fn on_voice_channel_unsubscribe(socket: SocketRef, data: Value, state: SioState, _io: SocketIo) {
    let channel_id = data.get("channelId")
        .and_then(|v| v.as_str())
        .unwrap_or("").to_string();
    if channel_id.is_empty() { return; }

    let user_id = match extract_user_id(&socket, &state) {
        Some(id) => id,
        None => return,
    };

    let mut voice = state.voice_channels.write().await;
    if let Some(entry) = voice.get_mut(&channel_id) {
        entry.listeners.retain(|uid| *uid != user_id);
    }
}
```

**Step 4: Wire in wiring.rs**

Change `wiring.rs:95` from:
```rust
socket.on("voice-channel-subscribe", {
    // ...
    async move { on_voice_channel_join(socket, data, s, io).await }
});
```
To:
```rust
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
```

**Step 5: Add listeners field to VoiceChannelState**

Check if the state struct has a `listeners` field separate from `participants`. If not, add it. The struct likely lives in `state.rs` or `shared.rs`.

**Step 6: Run tests**

Run: `cargo test -p wabi-server --lib voice_channels -- --nocapture`
Expected: PASS

**Step 7: Commit**

```bash
git add core/crates/wabi-server/src/socketio/voice_channels.rs core/crates/wabi-server/src/socketio/wiring.rs
git commit -m "fix: separate voice-channel-subscribe from join for TeamSpeak-style multi-listen"
```

---

### Task 2: Ensure on_voice_channel_join also subscribes listeners

**Objective:** When a user joins a voice channel (transmitting), they should also be in the listeners list automatically. This prevents a gap where a joined user doesn't receive other users' join/leave notifications.

**Files:**
- Modify: `core/crates/wabi-server/src/socketio/voice_channels.rs`

**Step 1:** In `on_voice_channel_join`, after adding the user to `participants`, also add them to `listeners` if not already present.

**Step 2:** In `on_voice_channel_leave`, remove from both `participants` AND `listeners`.

**Step 3:** Run: `cargo test -p wabi-server --lib voice_channels`
Expected: PASS

**Step 4:** Commit:
```bash
git commit -m "fix: voice channel join also subscribes; leave cleans up both lists"
```

---

### Task 3: Add offline-safe transport resolution

**Objective:** When the internet is out but the wabi server is reachable (localhost/LAN), calling should still work. The transport resolver must not fail just because external TURN or LiveKit is unreachable.

**Files:**
- Modify: `frontend/src/lib/mediaRuntime.ts`
- Modify: `frontend/src/lib/callingTransport.ts`

**Step 1: Add isLocalOrLanConnection helper in mediaRuntime.ts**

```typescript
/** Returns true if we're connected to a local wabi server (localhost or LAN). */
export function isLocalConnection(): boolean {
    const host = window.location.hostname;
    // localhost, 127.x, 10.x, 192.168.x, 172.16-31.x — all "local"
    if (host === 'localhost' || host === '127.0.0.1') return true;
    const parts = host.split('.').map(Number);
    if (parts.length === 4) {
        if (parts[0] === 10) return true;
        if (parts[0] === 192 && parts[1] === 168) return true;
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    }
    // Also check Tailscale 100.x range
    if (parts.length === 4 && parts[0] === 100) return true;
    return false;
}
```

**Step 2: Modify resolveCallTransportPlan to be offline-resilient**

In `resolveCallTransportPlan()`, wrap the `syncMediaRuntimeFromServer()` call and the LiveKit/TURN checks so that if they fail AND we're on a local connection, we default to 'wabidb' transport without a fallback warning:

```typescript
export async function resolveCallTransportPlan(): Promise<CallTransportPlan> {
    const mode = getStoredCallTransportMode();
    const local = isLocalConnection();
    let runtime: MediaRuntimeSnapshot | null = null;
    try {
        runtime = await syncMediaRuntimeFromServer();
    } catch {
        // Can't reach server for runtime — if local, assume wabidb works
        if (!local) {
            return { mode, effective: 'wabidb', fallbackApplied: true, reason: 'runtime_unreachable', gatewayHealthy: false, sfuProvider: null, checkedAt: Date.now() };
        }
        // Local connection but runtime sync failed — server is up (socket connected) 
        // but the runtime endpoint errored. Default to wabidb, don't alarm.
        return { mode, effective: 'wabidb', fallbackApplied: false, reason: 'local_default', gatewayHealthy: true, sfuProvider: null, checkedAt: Date.now() };
    }
    // ... existing logic continues unchanged
}
```

**Step 3: Guard prefetchTurnCredentials in callingTransport.ts**

In `resolveActiveTransport`, wrap TURN preflight so it doesn't block when external servers are unreachable:

The existing `resolveActiveTransport` already catches runtime sync failures. But the `prefetchTurnCredentials()` call in `calling_impl_core.ts` (before resolveActiveTransport) hits external TURN servers. Wrap it:

**Step 4: Wrap prefetchTurnCredentials in startCall/joinVoiceChannel/startGroupCall**

In `calling_impl_core.ts`, change every `await prefetchTurnCredentials()` to:
```typescript
await prefetchTurnCredentials().catch(() => {
    // TURN unreachable — fine if we're on wabidb transport or local
    console.warn('[Calling] TURN prefetch failed, continuing without TURN');
});
```

**Step 5: Run `bun run check`**
Expected: 0 errors

**Step 6: Commit**
```bash
git add frontend/src/lib/mediaRuntime.ts frontend/src/lib/callingTransport.ts frontend/src/lib/calling_impl_core.ts
git commit -m "fix: calling works offline when server is reachable on localhost/LAN"
```

---

### Task 4: Offline-mode awareness in calling — no infinite loops, no false errors

**Objective:** When the user is in offline/Work Offline mode and tries to call, show a clear message instead of silently failing or looping. If the socket is connected (local server), calling should work. If the socket is disconnected, show "No connection to server".

**Files:**
- Modify: `frontend/src/lib/calling_impl_core.ts`
- Modify: `frontend/src/lib/callingStateStores.ts`

**Step 1: Add socket connection check before starting any call**

In `startCall`, `startGroupCall`, `joinVoiceChannel` — after the "already in call" guard, add:
```typescript
if (!socket.connected) {
    throw new Error('No connection to server. Calls require an active connection to the Wabi server.');
}
```

**Step 2: Add offline call banner state to callingStateStores.ts**

```typescript
export const callOfflineNotice = writable<string | null>(null);
```

**Step 3: In the catch blocks of startCall/joinVoiceChannel/startGroupCall, check for connection errors**

If the error is a connection error (socket disconnected, transport resolution failed due to no network), set `callOfflineNotice` with a helpful message:
- "Server unreachable. If you're on the same network as the Wabi server, check that it's running."
- Clear the notice when a call successfully starts or when the socket reconnects.

**Step 4: Render the offline call notice in CallView.svelte or MainLayout**

Add a simple banner that shows when `callOfflineNotice` is non-null, similar to the offline banner in MainLayout.

**Step 5: Run `bun run check`**
Expected: 0 errors

**Step 6: Commit**
```bash
git add frontend/src/lib/calling_impl_core.ts frontend/src/lib/callingStateStores.ts frontend/src/lib/components/CallView.svelte
git commit -m "fix: offline calling shows clear notice instead of silent failure"
```

---

### Task 5: Settings.svelte clears wabi_has_logged_in on explicit logout

**Objective:** When a user explicitly logs out, clear the `wabi_has_logged_in` flag so offline reconnect mode doesn't trap them.

**Files:**
- Modify: `frontend/src/lib/components/Settings.svelte`

**Step 1:** Find the logout handler in Settings.svelte (or wherever the logout button dispatches).

**Step 2:** Add `localStorage.removeItem('wabi_has_logged_in')` in the logout flow, alongside the existing `clearAuthSession()` / `clearStoredIdentity()` calls.

**Step 3:** Run `bun run check`
Expected: 0 errors

**Step 4: Commit**
```bash
git add frontend/src/lib/components/Settings.svelte
git commit -m "fix: clear wabi_has_logged_in on explicit logout"
```

---

### Task 6: DM call end-to-end verification — ensure signaling flows complete

**Objective:** Verify the DM call path from startCall → call-initiate → call-incoming → call-accepted → call-offer → call-answer-sdp → call-ice-candidate → call-ended works without silent failures.

**Files:**
- Verify: `frontend/src/lib/calling_impl_core.ts` (startCall, acceptCall, endCall)
- Verify: `frontend/src/lib/socketConnectionCore.ts` (call event listeners)
- Modify: any gaps found

**Step 1: Read the full startCall → acceptCall flow**

Read lines 1166-1235 (startCall) and search for acceptCall/handleCallOffer/handleCallAnswer in calling_impl_core.ts.

**Step 2: Verify each Socket.IO event has a matching frontend listener**

Check that for every backend emit in `direct_calls.rs`:
- `call-incoming` → socketConnectionCore.ts listener exists ✓ (already done in F1)
- `call-accepted` → listener exists ✓
- `call-error` → listener exists ✓
- `call-rejected` → listener exists ✓
- `call-cancelled` → listener exists ✓
- `call-ended` → listener exists ✓

Check that for every frontend emit:
- `call-initiate` → backend handler `on_call_initiate` exists ✓
- `call-answer` → backend handler `on_call_answer` exists ✓
- `call-reject` → backend handler `on_call_reject` exists ✓
- `call-cancel` → backend handler `on_call_cancel` exists ✓
- `call-end` → backend handler `on_call_end` exists ✓
- `call-offer` → backend relay handler exists? Search direct_calls.rs for `call-offer`.
- `call-answer-sdp` → backend relay handler exists?
- `call-ice-candidate` → backend relay handler exists?

**Step 3: Fix any missing backend relay handlers**

If `call-offer`, `call-answer-sdp`, or `call-ice-candidate` relays are missing from the backend, add them. The server should receive these from the caller and forward to the target user's socket.

**Step 4: Run `cargo test -p wabi-server`**
Expected: all pass

**Step 5: Commit any fixes**
```bash
git commit -m "fix: complete DM call signaling relay chain"
```

---

### Task 7: Group call end-to-end verification

**Objective:** Verify startGroupCall → group-call-invite → group-call-participant-joined → group-call-participant-left → call-ended works.

**Files:**
- Verify: `frontend/src/lib/calling_impl_core.ts` (startGroupCall, enterEstablishedGroupCall)
- Verify: `core/crates/wabi-server/src/socketio/group_calls.rs`

**Step 1: Read the full group call flow**

Read lines 1302-1400 (startGroupCall) and enterEstablishedGroupCall (1237-1288).

**Step 2: Verify group-call-invite backend relay**

Check if `group-call-invite` is handled in the backend. The frontend `startGroupCall` should emit something like `group-call-invite` with target channel + invitees.

**Step 3: Verify the transport fallback in enterEstablishedGroupCall**

Lines 1276-1287 show wabidb → SFU fallback path. Verify this doesn't break when both are unavailable (should silently fall through to P2P).

**Step 4: Fix any gaps found**

**Step 5: Run `cargo test -p wabi-server` and `bun run check`**
Expected: all pass

**Step 6: Commit**
```bash
git commit -m "fix: complete group call signaling chain"
```

---

### Task 8: Voice channel join/leave end-to-end verification

**Objective:** Verify joinVoiceChannel → voice-channel-join → voice-channel-joined → voice-channel-user-joined → leaveVoiceChannel → voice-channel-leave → voice-channel-left → voice-channel-user-left works for all transports (wabidb, SFU, storefwd).

**Files:**
- Verify: `frontend/src/lib/calling_impl_core.ts` (joinVoiceChannel, leaveVoiceChannel)
- Verify: `core/crates/wabi-server/src/socketio/voice_channels.rs`

**Step 1: Verify voice-channel-join backend handler**

Read voice_channels.rs. Verify it:
- Adds user to participants
- Emits voice-channel-joined to the joining user
- Emits voice-channel-user-joined to other channel members
- Emits voice-channel-state with current members

**Step 2: Verify voice-channel-leave backend handler**

Read the leave handler. Verify it:
- Removes user from participants
- Emits voice-channel-left to the leaving user
- Emits voice-channel-user-left to remaining members

**Step 3: Verify multi-listen (subscribe) flow after Task 1 fix**

With the Task 1 fix in place, verify that:
- `addVoiceChannelListen` → `voice-channel-subscribe` → backend adds to listeners, NOT participants
- `removeVoiceChannelListen` → `voice-channel-unsubscribe` → backend removes from listeners
- A listening-only user receives voice-channel-user-joined/left events but does NOT appear as a participant to others

**Step 4: Run `cargo test -p wabi-server`**
Expected: all pass

**Step 5: Commit any fixes**
```bash
git commit -m "fix: voice channel join/leave/subscribe end-to-end verification"
```

---

### Task 9: Offline call integration — localhost calling

**Objective:** When offline (Work Offline mode) but the socket is connected to a local wabi server, calls should route through the wabidb transport without attempting external TURN/STUN/LiveKit. Verify this works.

**Files:**
- Verify: `frontend/src/lib/calling_impl_core.ts` (all call entry points)
- Verify: `frontend/src/lib/mediaRuntime.ts` (transport resolution)
- Verify: `frontend/src/lib/callingWabidb.ts` (wabidb transport)

**Step 1: Verify the wabidb transport doesn't need external network**

Read `callingWabidb.ts` and `wabidbCallConnection.ts`. The wabidb transport:
- Creates a WabiDbCallState connected to the wabi server WebSocket
- Creates a session, joins it
- Uses wabidbMediaRelay for audio (Socket.IO binary relay)
All of this is local — no external network needed. ✓

**Step 2: Verify the transport resolver defaults to wabidb when external services are unreachable**

After Task 3, the resolver should return 'wabidb' when:
- syncMediaRuntimeFromServer fails + isLocalConnection is true
- OR mode is 'auto'/'wabidb' (default)

**Step 3: Verify no infinite retry loops occur when offline**

Check that:
- `prefetchTurnCredentials` catch handler (from Task 3) logs the warning and continues
- `resolveActiveTransport` doesn't retry syncMediaRuntimeFromServer in a loop
- `connectWabidbCall` has a timeout (10s) and doesn't retry

**Step 4: Test by building and running locally**

```bash
cd /var/home/Ronin/wabi
cargo build -p wabi-server
cd frontend && bun run build
```
Expected: both succeed

**Step 5: Commit**
```bash
git commit -m "verify: offline localhost calling through wabidb transport"
```

---

### Task 10: Full build + type check verification

**Objective:** All changes compile and type-check cleanly.

**Step 1: Backend**
```bash
cd /var/home/Ronin/wabi && cargo build -p wabi-server
```
Expected: success

**Step 2: Backend tests**
```bash
cargo test -p wabi-server
```
Expected: all pass

**Step 3: Frontend type check**
```bash
cd frontend && bun run check
```
Expected: 0 errors

**Step 4: Commit if any final fixes needed**
```bash
git commit -m "verify: full build + type check passes"
```

---

## Verification Criteria

| Area | How to verify | Expected |
|------|---------------|----------|
| DM calls | startCall from user A → user B sees incoming → accept → audio flows → end | ✓ |
| Group calls | startGroupCall in channel → invited users see ringing → join → audio flows | ✓ |
| Voice channels | joinVoiceChannel → others see user joined → audio flows → leave → others see user left | ✓ |
| TeamSpeak multi-listen | addVoiceChannelListen to ch2 while in ch1 → hear ch2 audio without leaving ch1 → removeVoiceChannelListen → stop hearing ch2 | ✓ |
| Offline localhost calling | Disconnect internet → socket still connected to localhost → startCall → wabidb transport → audio flows | ✓ |
| Offline no internet + no server | Disconnect everything → Work Offline mode → attempt call → clear error message, no infinite loop | ✓ |
| Offline boot survival | Reload while offline → returning user sees reconnect shell → Work Offline button → app loads in offline mode | ✓ |
| Explicit logout clears flag | Logout → reload while offline → see login screen (not stuck in reconnect) | ✓ |

---

## Notes

- The "TeamSpeak multi-join" feature is the `listeningVoiceChannels` / `addVoiceChannelListen` / `removeVoiceChannelListen` system — NOT a TeamSpeak protocol integration. It lets users listen to multiple voice channels simultaneously while transmitting in only one, inspired by TeamSpeak's multi-channel listening.

- The offline calling concern is NOT about making calls without a server. It's about: (1) the wabi server is reachable on localhost/LAN even when the internet is out, (2) calling code shouldn't fail because it can't reach external TURN/STUN/LiveKit, (3) users should get clear feedback when calling truly isn't possible.

- The `wabidb` transport (default) requires only a WebSocket connection to the wabi server. It doesn't need UDP, TURN, STUN, or any external service. This is why it's the right default for offline/localhost scenarios.

- Task numbering is sequential. Tasks 1-2 fix the backend multi-listen bug. Task 3-5 fix offline resilience. Tasks 6-8 verify the three call surfaces. Tasks 9-10 verify offline integration and build.
