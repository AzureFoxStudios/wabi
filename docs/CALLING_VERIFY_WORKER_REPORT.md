# Calling contract verification report (DM / group / voice)

Verification worker. Workdir `/var/home/Ronin/wabi`. Traced every frontend emit
against its backend handler and back. Note: files were being edited concurrently
by another worker during this pass (voice-channel subscribe/unsubscribe landed
mid-review); all findings below reflect the state after re-reading before edit.

## Confirmed OK contracts

### DM call path (traced end to end)
- `startCall` → emit `call-initiate {targetUserId,isVideoCall}` → backend
  `on_call_initiate` DM branch → `call-incoming {userId,username,isVideoCall}`. OK
- `answerCall` → emit `call-answer {callerId,isVideoCall}` → `on_call_answer` DM
  branch → `call-accepted {userId,username,isVideoCall}`. OK
- caller `call-accepted` → `beginEstablishedDirectCall` + `createCallOffer` →
  emit `call-offer {offer,targetId}` → `on_call_offer` (no channelId ⇒ skips
  membership check) → `call-offer {offer,senderId,username,channelId}`. OK
- callee `handleCallOffer` → emit `call-answer-sdp {answer,targetId}` →
  wiring relay → `call-answer-sdp {answer,senderId}` → `handleCallAnswer`. OK
- ICE both directions: emit `call-ice-candidate {candidate,targetId}` → relay
  `{candidate,senderId}` → `handleCallIceCandidate`. OK
- `endCall` (direct, participants>0, not group) → emit `call-end {participants}`
  → `on_call_end` → `call-ended {userId}` → `handleRemoteDirectCallEnded`. OK

### Group call path
- `startGroupCall` / `handleGroupCallParticipantJoined` /
  `enterEstablishedGroupCall` event names all match backend
  (`call-initiate` w/ channelId, `group-call-participant-joined`,
  `group-call-participant-left`, `group-call-invite-cleared`,
  `group-call-stop-ringing`, `group-call-leave`). OK
- Transport fallback in `enterEstablishedGroupCall` (wabidb → SFU → P2P) is fully
  wrapped in try/catch; a relay failure logs and continues. No throw-into-loop. OK

### Voice channels
- `voice-channel-join` / `-subscribe` / `-unsubscribe` / `-leave` are all wired
  (concurrent worker added listen-only-aware `on_voice_channel_subscribe` /
  `on_voice_channel_unsubscribe`). `addVoiceChannelListen`/`removeVoiceChannelListen`
  map to subscribe/unsubscribe. OK — no gap remaining.

### join-wabidb-call (job item 6)
- Frontend `connectWabidbCall` emits `join-wabidb-call {sessionId,channelId}`;
  backend `on_join_wabidb_call` is wired (wiring.rs) and joins the socket to room
  `wabidb-call-{sessionId}`; `wabidb-media` relay uses that room. NOT a dead emit.
  Left as-is.

### Retry loops (job item 5)
- `startCall`/`startGroupCall` emit once, no retry loop. Socket reconnect storms
  are guarded by the circuit breaker in `socketConnectionCore.ts`
  (`fastReconnectCount`, connect cooldown). No call-start loop found.

## Actual bugs fixed

1. **`leaveVoiceChannel` leaked the wabiDB transport.**
   `joinVoiceChannel` connects wabiDB (`connectWabidbCall`, calling_impl_core.ts
   ~1057) but `leaveVoiceChannel` only tore down LiveKit, never wabiDB — unlike
   `finalizeLocalCallEndState` which disconnects both. Added
   `void disconnectWabidbCall();`
   - `frontend/src/lib/calling_impl_core.ts:1173`

2. **Rejected / errored outgoing DM call left the caller stuck "ringing".**
   `call-rejected` and `call-error` (targetUserId) are delivered to the *caller*,
   who holds an `outgoingCall`, not an `incomingCall`. The old
   `handleIncomingCallCancelled` only cleared `incomingCall`, so the caller's
   ringing UI and captured mic stream were never released. Added an outgoing-call
   branch that runs `finalizeLocalCallEndState()` when the pending non-group
   outgoing call targets the caller.
   - `frontend/src/lib/calling_impl_core.ts:1512` (`handleIncomingCallCancelled`)

## Verify results
- `cargo check -p wabi-server` → Finished, 0 errors (pre-existing dead-code warnings only)
- `cd frontend && bun run check` → 0 errors, 75 warnings (all pre-existing, unrelated)

## Remaining untested runtime smoke (not code gaps)
- Live DM audio between two clients (offer/answer/ICE handshake over a real socket).
- Voice-channel join then leave while on the wabiDB transport — confirm the relay
  and session actually close after fix #1 (verified by code path, not runtime).
- Caller UI dismissal after a real callee reject/decline (fix #2), incl. mic LED off.
- Group call fallback when wabiDB is down and LiveKit is also unreachable → P2P.
- `call-error` for a *group* outgoing call still isn't cleared (scope guarded to
  `!== 'group'`); left untouched intentionally — outside the DM job scope and
  overlaps the concurrent group/offline work.
