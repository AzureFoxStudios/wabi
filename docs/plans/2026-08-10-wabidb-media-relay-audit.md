# 2026-08-10 — Wabidb Media Relay Audit (Council of Judgment)

**Question:** Can `WabidbMediaRelay` serve as a full media relay that replaces P2P+TURN, or is it just a capture/recording layer?

**Scope:** Read-only audit of exactly 8 files. No edits, no commits.

---

## Section 1: ACTUAL FINDINGS (verified from source)

### 1.1 `WabidbMediaRelay` is a live audio relay, NOT a recorder

The class is a full duplex opus-over-socket.io pipeline, not a local capture/recording layer:

- **Capture/encode/send:** `getUserMedia` stream → `OpusRecorder` WASM encoder → `socket.emit('wabidb-media', { sessionId, userId, payload })`. (`frontend/src/lib/wabidbMediaRelay.ts:46-79`, emit at `:71-75`)
- **Receive/decode/playback:** listens for `'wabidb-media'` (`:86`), buffers into a jitter buffer (`:98-104`), drains on a 20 ms timer (`:106-127`), decodes via opus-recorder decoder worker (`:143-201`), plays through an AudioWorklet (`:203-217`).
- **Peer filtering:** incoming media is only played if `msg.userId !== this.userId && msg.sessionId === this.sessionId` (`:81-85`) — i.e. it is scoped to the relayed audio of *other participants in the same session*. This is peer-to-peer relay behavior.
- **Nothing is persisted.** All receive state is an in-memory `JitterEntry[]` (`:17-20`, `:31`). `stop()` tears everything down (`:219-247`). There is no recording, no disk write, no event-store write.

Verdict on the framing: the "capture/recording layer" label is FALSE. The client does relay audio peer-to-peer. But it relays only **audio, mono, 48 kHz opus** — no video, no screen share.

### 1.2 The relay is client-side; the server relay handler exists but is dead-coded

- Client sends on `wabidb-media` and the server *should* fan it out: `on_wabidb_media` re-emits to the `wabidb-call-{sessionId}` room, excluding the sender. (`core/crates/wabi-server/src/socketio/media_reactions_signaling.rs:23-46`, fan-out at `:40-45`)
- `on_join_wabidb_call` joins the sender's socket into that room. (`media_reactions_signaling.rs:11-20`)
- **Critical caveat:** every handler in all three audited server files carries `#[allow(dead_code)]` (`media_reactions_signaling.rs:10,22,48,85,150,217,311,345,361,394,418,442,491,520`; `voice_channels.rs:10,106,170,228,285`; `direct_calls.rs:10,236,344,419,478`). `#[allow(dead_code)]` suppresses "function never used" warnings — a strong signal these handlers are **not wired into the socket.io router**. The router/registration file is outside the audited set, so whether `wabidb-media`/`join-wabidb-call` are actually reachable at runtime is **UNVERIFIABLE from these files** and must be checked before trusting the wabidb audio path.
- Media never touches WabidbDB/the event store. `WabiDbCallState` is used only for the session roster (`frontend/src/lib/callingWabidb.ts:79-124`); the audio goes over plain socket.io. The code itself says so: *"call audio still uses socket.io; only the session-state path is migrated."* (`callingWabidb.ts:129-132`)

### 1.3 The socket.io WebRTC signaling path is still fully present and active client-side

`call-offer` / `call-answer-sdp` / `call-ice-candidate` all exist in the client:

- `createPeerConnection` constructs `new RTCPeerConnection(getRTCConfig())` and wires ICE → `socket.emit('call-ice-candidate', …)` (`calling_impl_core.ts:335`, `:394-402`) and tracks → `addRemoteCallStream` (`:405-436`).
- Offers: `socket.emit('call-offer', …)` at `calling_impl_core.ts:497-501` (renegotiation) and `:1981-1985` (`createCallOffer`).
- Answers: `socket.emit('call-answer-sdp', …)` at `calling_impl_core.ts:2030-2033`.
- Server-side, only `on_call_offer` exists as a relay for the SDP path (`media_reactions_signaling.rs:218-308`, relay at `:296-307`). **There is no `call-answer-sdp` or `call-ice-candidate` handler anywhere in the audited server files** — the closest are `on_webrtc_answer`/`on_webrtc_ice_candidate` for the `webrtc-*` event names (`media_reactions_signaling.rs:395-440`) and `p2p-*` file-transfer relays (`:443-547`). Where DM SDP answers/ICE are served is **UNVERIFIABLE** from the audited set.
- TURN is still part of the P2P path: `prefetchTurnCredentials()` runs before DM `startCall`, `answerCall`, group calls, and voice-channel joins (`calling_impl_core.ts:1115,1287,1560`, `:1448`), and `getRTCConfig()` feeds it into each `RTCPeerConnection` (`:335`).

### 1.4 Transport resolution: wabidb is the *default* for channels/groups; DM calls resolve to p2p

- `resolveCallTransportPlan()` with no stored mode falls through to `effective: 'wabidb'` (`frontend/src/lib/mediaRuntime.ts:344`; stored modes read at `:181-187` where legacy `'stdb'` maps to `'wabidb'`).
- `resolveActiveTransport()` **without a channelId returns `'p2p'` unconditionally** (`frontend/src/lib/callingTransport.ts:40-56`). DM calls call it with no channelId (`calling_impl_core.ts:1290`, `:1581`).
- Voice channels and group calls call it with a channelId, so they land on `'wabidb'` (`calling_impl_core.ts:1118`, `:1402`) and invoke `connectWabidbCall` (`:1144-1152`, `:1405-1415`), with LiveKit/SFU as the fallback if wabidb fails (`:1408-1415`).

### 1.5 Summary of what the code actually does

| Claim | Source-verified? | Where |
|-------|------------------|-------|
| Relay captures + sends opus over socket.io | YES | `wabidbMediaRelay.ts:69-77` |
| Relay receives + decodes + plays back remote audio | YES | `wabidbMediaRelay.ts:81-86,129-217` |
| Relay handles video / screen share | NO (audio-only) | class is opus-only; video stays in WebRTC `calling_impl_core.ts:1924-1939` |
| Server relays `wabidb-media` to session room | PARTIAL — handler defined, but `#[allow(dead_code)]`; registration unverifiable | `media_reactions_signaling.rs:23-46` |
| Media rides WabidbDB / event store | NO — socket.io only; WabiDbCallState is roster-only | `callingWabidb.ts:79-124,129-132` |
| Socket.io P2P signaling (`call-offer`/`call-answer-sdp`/`call-ice-candidate`) still wired client-side | YES | `calling_impl_core.ts:497,1981,2030,394` |
| Server handlers for `call-answer-sdp` / `call-ice-candidate` | ABSENT from audited server files (unverifiable elsewhere) | — |
| Default transport = wabidb (channel/group) | YES | `mediaRuntime.ts:344`; `calling_impl_core.ts:1144,1405` |
| DM calls = p2p | YES | `callingTransport.ts:55`; `calling_impl_core.ts:1290` |
| TURN still consulted on P2P/SFU paths | YES | `calling_impl_core.ts:1115,1287,1560` |

---

## Section 2: WHAT'S MISSING (to make Wabidb a full relay replacing P2P+TURN)

1. **Wire the server handlers.** All relay/signaling handlers are `#[allow(dead_code)]` (`media_reactions_signaling.rs:10,22,...`; `voice_channels.rs:10,...`; `direct_calls.rs:10,...`). Register `join-wabidb-call`, `wabidb-media` (and the call SDP/ICE relays) in the socket.io router, or the wabidb path and DM signaling are silent no-ops. *This is the single most important unknown — it gates everything else.*

2. **Server-side auth.** `on_wabidb_media` trusts client-supplied `sessionId`/`userId` (`media_reactions_signaling.rs:24-32`). Other handlers derive identity from the JWT (`user_id_from_token`, `direct_calls.rs:22`); the media relay should too, or any authenticated socket can inject/relay arbitrary audio into any session room.

3. **Video.** `WabidbMediaRelay` is audio-only mono opus. Video calls today use WebRTC track paths (`calling_impl_core.ts:1924-1939`). A full relay needs a video encode/relay/decode path (or a mixed client-server solution).

4. **Echo cancellation.** The relay captures mic (with getUserMedia AEC, `mediaRuntime.ts:171-179`) *and* plays remote audio back through the same device via AudioWorklet (`wabidbMediaRelay.ts:203-217`). There is no AEC across the capture/playback loop in the relay — echo is handled today only because the WebRTC path has native AEC. The relay needs its own AEC or it will feed the mic with its own output.

5. **Network adaptation / QoS.** The jitter buffer is a fixed 80 ms timer with a 50-entry cap and hard drop (`wabidbMediaRelay.ts:36,101-103,113-127`). There is no loss concealment, retransmission, adaptive bitrate, or congestion control (no RTP/RTCP-style feedback over the socket.io binary emit).

6. **Mesh efficiency, not an SFU.** The server fan-out is a full echo: every participant gets every other participant's stream (`media_reactions_signaling.rs:38-45`). N participants → N×(N−1) streams through the single wabi-server websocket process. No server-side mixing, VAD-based selective forwarding, or bitrate scaling. Replacing P2P+TURN with this moves all WAN traffic through one process and multiplies it.

7. **Nothing rides WabidbDB.** If "Wabidb media transport" is meant to mean the event-sourced store, there is zero media integration — `WabiDbCallState` handles only session roster/state (`callingWabidb.ts:79-124`). Making it a genuine Wabidb transport would mean routing media (or its metadata/retention policy) through the store/session layer, not just socket.io.

---

## Section 3: ARCHITECTURE VERDICT

**Does Wabidb eliminate TURN? Not today, and not fully — but the seed is real.**

- **In the `wabidb` transport mode, TURN is genuinely out of the path.** `WabidbMediaRelay` never constructs an `RTCPeerConnection`; it ships opus over the existing socket.io/WebSocket connection (`wabidbMediaRelay.ts:71-75,86`). No ICE, no `iceServers`, so no TURN is consulted. Socket.io rides the same server connection the REST/roster traffic uses.
- **But it only replaces TURN for the wabidb audio path**, and that path is only taken for voice channels and group calls by default (`mediaRuntime.ts:344`; `calling_impl_core.ts:1144,1405`). **DM calls resolve to `p2p`** (`callingTransport.ts:55`) and video/screen-share go over WebRTC with `getRTCConfig()` + `prefetchTurnCredentials()` (`calling_impl_core.ts:335,1287`). So P2P+TURN still covers a major slice of real calls.
- **Server-side readiness is unverified.** The relay handlers are all `#[allow(dead_code)]`; if they are not registered, `wabidb-media` emits vanish server-side and the "wabidb default transport" delivers **no remote audio at all** (local echo only, and even capture depends on the socket).

**Bottom line:** `WabidbMediaRelay` is a legitimate server-relayed live audio path (not a recorder), and as a WebSocket-backed transport it inherently needs no TURN. It is not a complete media relay: it lacks video, AEC, QoS, server registration (unverified), auth on the media event, and any DB/event-store involvement, and it is a full-mesh echo rather than an SFU. It **does not currently eliminate TURN** across the product.

---

## Section 4: CONCRETE NEXT STEPS (short list)

1. **Verify handler registration.** Find the socket.io router file (outside this audit scope) and confirm whether `join-wabidb-call` / `wabidb-media` / `call-offer` / `call-answer-sdp` / `call-ice-candidate` are actually registered; remove stale `#[allow(dead_code)]`. This determines whether the wabidb default transport and DM signaling work at all.
2. **Decide the target.** For "replace TURN," a WebSocket/socket.io relay already suffices and needs no DB work. For "replace P2P entirely" (video + SFU-quality), budget real work: video relay, server AEC, selective-forwarding/mixing, and QoS.
3. **Harden the relay path:** derive `userId` from the JWT server-side (`media_reactions_signaling.rs:24-32` → mirror `direct_calls.rs:22` pattern), add loss/jitter handling beyond the 50-entry hard cap, and confirm AEC behavior before the wabidb transport is the default for audio.
4. **Document the real matrix** in the plan doc: wabidb = audio-only, channel/group default, no TURN; P2P = DM + video, TURN still active; SFU/LiveKit = optional upgrade path (`calling_impl_core.ts:1136-1138`). Correct any architecture comparison table that claims WabidbMediaRelay is a capture/recording layer or that it already replaces TURN.

---

### Unverifiable claims (explicitly noted)
- Whether the audited server handlers are registered in the socket.io router (all `#[allow(dead_code)]`; router file not in scope).
- Where/whether `call-answer-sdp` and `call-ice-candidate` are handled server-side (absent from audited server files).
- The contents of the architecture comparison table itself (not in the audited file set); Section 1.5 and Section 3 state what the source does show, which is the basis for judging the table.
