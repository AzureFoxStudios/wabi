# HANDOFF — Calling Overhaul, Phase 1 nearly done — 2026-08-25 (updated after diff review)

**For:** Muse-Spark or Ox-Alpha (model-agnostic — any Svelte 5 / Rust agent). Low-mode capable.
**From:** Muse-Spark (follow-up to ZCode/GLM-5.3 session that ran out of budget at 15%)
**SoT plan:** `docs/plans/2026-08-25-calling-overhaul.md` — read that FIRST. This handoff captures in-flight state.

---

## 1. What the previous agent did (verified by diff review)

Phase 1 = backend security hardening (SEC-1..SEC-4). All code is **already written and now compiles**.

**New file:**
- `core/crates/wabi-server/src/socketio/call_security.rs` (461 lines) — token-bucket rate limiter, DM link registry, pure auth fns `authorize_wabidb_session_join` + `signaling_consent_allowed`, 7 unit tests. Included via `socketio_impl.rs: include!("socketio/call_security.rs")`. **Fixed 2026-08-25 by this session:** renamed `mod tests` → `mod call_security_tests` — the flat `include!` module already has a `mod tests` in `shared.rs`, so duplicate name caused `E0428` on `cargo test`. `cargo check` had hidden it.

**Modified Rust:**
- `socketio/media_reactions_signaling.rs` — `on_join_wabidb_call` now `async fn(..., state: SioState, _io)` with roster/group/dm authorization, guests rejected, emits `wabidb-call-denied` on denial; `on_wabidb_media` requires `SioIdentity`, checks `socket.rooms()` membership, rate-limits via `media_rate_allow`, rewrites `payload["userId"]` to server-attested id; `on_call_offer` channel-less branch gated; `on_webrtc_offer/answer/ice` gated via new `signaling_consent()` helper; `screen_share` scoped via new `screen_share_audience()` to `io.to(Vec<String>)` instead of `io.broadcast()`.
- `socketio/wiring.rs` — `call-answer-sdp` + `call-ice-candidate` inline handlers gated; `join-wabidb-call` registration now passes `state`.
- `socketio/direct_calls.rs` — `dm_link_remember/forget` on initiate/answer/reject/cancel/end.
- `socketio/presence.rs` — `on_disconnect` calls `media_rate_forget` + `dm_link_clear_user`.
- `api/media.rs` — all `/api/media/rooms*` take `AuthUser`; `assign_room`/`close_room`/`mark_active`/`list_rooms` admin-gated via `state.is_admin`; new `MediaApiError::Forbidden` → 403.
- `socketio_impl.rs` — one line include.

**Modified Frontend:**
- `frontend/src/lib/callingWabidb.ts` — `onWabidbCallDenied` handler + `socket.off/on('wabidb-call-denied')` → `transportWatchdog.handleDisconnect()` fallback.
- `frontend/src/lib/calling_impl_core.ts` — **Critical ordering fix:** `voice-channel-join` / `voice-channel-subscribe` now emitted BEFORE `connectWabidbCall` in both `joinVoiceChannel` and `handleForcedVoiceMove`. Without this, server's roster check denied every channel relay (previous code emitted relay `join-wabidb-call` first).

**Plan SoT:**
- `docs/plans/2026-08-25-calling-overhaul.md` (113 lines, SoT — do not re-derive plan from chat).

Diff reviewed 2026-08-25: logic correct, no E2EE scope creep, session keys and envelope handling match client contract. Only bug was the `mod tests` collision (fixed). `cargo fmt` not yet run.

## 2. Verified status

```
cargo check -p wabi-server   → 0 errors, ~60 warnings (only deprecation/dead_code baseline)
cargo test -p wabi-server --lib → 122 passed (7 call_security tests ×2 due to lib+bin crate duplication — harmless)
bun run check (frontend)     → 0 errors, 181 warnings (baseline)
```

The 18 errors from the GLM session's final minutes are resolved. E0599 on `socket.rooms()` / `io.to(Vec<String>)` / `payload["userId"]` that was feared does not reproduce on socketioxide 0.16.

## 3. Low-mode vs max-mode answer

**Low mode is fine for the rest of Phase 1.** Remaining Phase 1 work is scoped commits + 2-browser smoke. No long context needed.

Phase 2+ (replace 2,435-line `calling_impl_core.ts` with `CallSessionManager` + shared AudioContext + per-call sounds) is high-context; low mode can do it but should be chunked one sub-phase per turn with explicit file reads. If you have budget, switch to max for Phase 2 start. For Phase 1 closure, stay in low.

## 4. Finish Phase 1 — exact next steps (copy-paste)

1. `cargo fmt` on changed Rust files only (don't reformat `media_reactions_signaling.rs` wholesale — style is non-standard by inheritance).
2. ~~Commit in 2–3 scoped commits~~ **DONE by ZCode relay session (2026-08-25):**
   - `fffc645` — server: harden wabidb relay + signaling + media rooms (SEC-1..4)
   - `cc1f18c` — frontend: handle denied relay + fix voice join order
   - Docs commit follows this edit. Tree is clean; nothing else pending commit.
   Do NOT push/deploy without Ronin's explicit word. Never `git add -A` (noise-file rule).
3. Smoke with Ronin in 2 real browsers (headless cannot render Wabi — Skia crash):
   - voice channel join → not denied, audio flows; second channel listen-only; DM call; kill-tab → roster clears; attack: uninvited account `join-wabidb-call` for foreign `channel:*` → `wabidb-call-denied` + server `DENIED` log; spoofed `userId` in `wabidb-media` is rewritten at receiver.
4. After green, start Phase 2 per plan doc (CallSessionManager). No parallel subagents (AGENTS.md golden rule 10: one Agent per message or 429).

## 5. Hard-won facts (don't re-research)

- **Session keys:** channel `channel:{id}` (trimmed), DM `dm:{a}:{b}` with ids bare-digits→`user-{n}`, SORTED (`wabidbMediaRelay.ts:54-65`). Server recomputes exactly.
- **Envelope:** `{sessionId, userId, payload}` on `wabidb-media`; receivers key by `userId` (bare numeric, `toStableUserKey` → `user-42`). Server now stamps `userId`.
- **Flat module trap:** `socketio_impl.rs` includes all `socketio/*.rs` into ONE flat module — no `mod`/`use super::` needed; duplicate `use` = E0252. Tests modules must have unique names.
- **Voice roster:** `state.voice_channels: HashMap<channel_id, Vec<VoiceParticipant{socket_id, stable_id("user-{n}"|socket-id-guest), is_listening_only}>>`; listen-only subscribe lands there too. Groups: `state.group_call_sessions: HashMap<channel_id, GroupCallSession{connected_participants: HashSet<stable_id>}>` populated before media connects.
- **Sockets join room named their stable_id** (`presence.rs:40`), so `io.to(stable_id)` works.
- **FE join order:** presence BEFORE `connectWabidbCall` (watchdog reconnect path on live socket is safe — roster persists; new socket relies on drain map re-emit).
- **Golden rules:** AGENTS.md §§1-10 apply (no terser, Svelte 5 runes only, UUID message ids, dual-decode for postcard records, two lock files `data/wabi-server/.lock` + `data/wabi-server/wabidb/.lock`, lore out of scope). `packages/wabi-protocol` is generated — don't hand-edit.
- **Frontend baseline:** `bun run check` 0 errors / 181 warnings; `bun test` tripwires must stay green. Transport registry at `frontend/src/lib/callingTransports/registry.ts`, god-module at `frontend/src/lib/calling_impl_core.ts` (2,435 lines, Phase 2 replaces).

## 6. Where to start

- Plan SoT: `docs/plans/2026-08-25-calling-overhaul.md`
- Prior audit shipped `232dea4..9acce88`: `docs/plans/2026-08-24-calling-audit-fixes.md`
- Security module: `core/crates/wabi-server/src/socketio/call_security.rs`
- Audit history + transport/watchdog context: plan doc + this handoff §1

## 7. Original plan (verbatim copy for offline use)

> See `docs/plans/2026-08-25-calling-overhaul.md` — full verbatim kept there as SoT. Pasted here only for handoff portability if the receiving agent cannot read that file:

Wabi Calling Overhaul — "9th Attempt, Do It Right" — 2026-08-25
Decisions locked: replace the middle keep the ends (transport/fallback/watchdog + dual-source wabidbVideoLane + roster + TURN + sounds stay; calling_impl_core.ts + CallModal.svelte replaced by CallSessionManager + runes UI); auth+membership hardening only (no relay E2EE); voice view = dedicated 'voice' workspace view; spatial drag chips only when spatial ON, personal localStorage, auto-circle default, silly physics deferred.
SEC-1 Critical wabidb-media relay no membership/identity check spoofable; SEC-2 High /api/media/rooms unauthenticated; SEC-3 Medium SDP to any socket; SEC-4 Low screen-share global broadcast. TURN ephemeral HMAC-SHA1 behind AuthUser OK; socket handshake validates JWT but guests stay connected — media events must reject.
Discord fluidity = gateway VOICE_STATE_UPDATE + local cache + READY initial — Wabi backend already does this; goal 2 is client optimistic chip + connecting→connected + per-call sounds + tripwires.
Phases: 1 backend hardening (authorize join-wabidb-call, stamp userId, rate limit, AuthUser+admin on media rooms, consent on webrtc, scope screen-share, tests); 2 CallSessionManager per-call {id,kind,transport,direction,focus,volume,muted,participants,spatialSeats,state} one focused one AudioContext Gain→panner, per-call sounds, singleton captures, DM/group migration, shim, tripwire tests; 3 CallStage runes avatar chips + video + spatial drag + quick toggle; 4 voice view + right-panel calls panel; 5 fluidity + regression + 2-client smoke + scoped commits + threat model note. Risks: Svelte legacy tripwire runes-only, single AudioContext CPU, no postcard record changes (golden rule 5).
