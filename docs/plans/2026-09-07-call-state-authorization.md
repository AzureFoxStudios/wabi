# Call-state authorization and recovery — 2026-09-07

Status: implemented and verified locally. No push, deployment or live-data changes.

## Objective and evidence

Close the separate REST/raw-WebSocket call-state boundary without changing the
Socket.IO audio transport. The previous `/ws` permitted unauthenticated subscriptions
and forwarded client-supplied server events globally. Call REST authenticated a
JWT but did not authorize the session; create overwrote the same session on
every reconnect, join accepted a forged stable identity, and any account could end
another call. Signal history split composite keys at their first colon although
real session IDs contain colons; its process counter could overwrite prior signals
after restart.

Use a single session access policy for HTTP reads/writes and WS subscriptions/
push. Channel calls derive access from persisted live-channel membership; direct
calls use the canonical two-principal session key, not the legacy UI channel hint.
Active session scope/host must not be replaced by repeat create. Join identity is
server-derived; session control and targeted signals require explicit authority.
Keep existing event/projection encodings and command acknowledgment guarantees.

The raw socket is now a bounded authenticated call-state subscription stream,
not a second client-write/broadcast API. One connection loop owns authentication,
subscriptions and delivery. The client becomes ready only after auth acknowledgment,
preserves stacked connect waiters, renews credentials and rejects stale socket
callbacks. Credentials must stay bound to the selected server/account.

Verify previous failures, real HTTP+WS+temporary WabiDB behavior, refresh and
reconnect state machines, replay, broader server/frontend tests, headful browser
behavior and web/Tauri frontend builds. Native packaging/cross-network audio are
separate release gates. Durable group removal and broader admin-auth consolidation
remain subsequent objectives.

## Implemented contract

- `call_access.rs` shares principal/session/channel/DM-pair checks. Active users
  are required. Private group calls have no admin membership bypass. Voice calls
  retain the shared ordinary-channel administrative policy.
- Active create is an authorized no-op, never an ownership/scope rewrite. Join
  uses `user-{authenticated id}`, correct host status, idempotency and serialized
  capacity checks. Missing/ended sessions cannot gain orphan participants or
  signals. Only the persisted host may end a call. Reusing an ended deterministic
  key retires prior participation through existing leave events.
- Session-striped locks bound synchronization memory and cover write validation,
  durable allocation, applied reads and publication. Socket network writes release
  these locks first, so a slow receiver cannot hold up a call's command writer.
- Signal IDs come from a reverse scan of the persisted session tail, not a process
  counter or full-history decode. History uses a session prefix and final-colon
  split; decode failures propagate. Live payloads come from the applied projection,
  including its exact timestamp. Reads/push filter targeted signals to sender and
  recipient and exclude prior ended-session generations.
- `/ws` accepts only Authenticate/SubscribeCall/UnsubscribeCall inputs, separate
  from server event types. It has one lifecycle owner, no client broadcast channel,
  no global connection/subscription registry, 16 KiB incoming messages, a 5-second
  initial auth deadline, 64 subscriptions, bounded writes and heartbeat expiry.
  Account access JWTs only; same-account renewal, strict expiry, live and idle
  revocation checks. Authorized snapshots/cursors repair reconnects; broadcast lag
  explicitly requests resubscription rather than silently dropping changes.
- Browser/Tauri readiness waits for the authenticated ACK. Stacked waiters,
  generation guards, reference-counted subscriptions and signal deduplication
  preserve overlap/reconnect correctness. No captured-token fallback after logout.
  Refresh is single-flight per server, sends to that server, preserves credentials
  on transient failures and refuses late responses after account/logout changes.
  Remembered access tokens are also cleared after definitive refresh rejection.
  Proactive renewal retries transient failures only within the valid token lifetime.
- Call setup no longer continues into a successful relay after REST join failure.
  The default call endpoint resolves the selected server at runtime (including
  Tauri), not an empty relative URL. No codec/DSP/native audio code changed.

## Verification and honest limits

Before the fix, a real loopback Axum `/ws` echoed an anonymous client's forged
`message-received` canary as a server event. The initial REST fixture separately
failed at middleware because it lacked `ConnectInfo`; that was a fixture error,
not evidence of endpoint authorization. The corrected tests now exercise all
guarded REST operations and actual WebSocket upgrades against temporary WabiDB.

Commands and results:

- `cargo test -p wabi-server --features addons`: **406 passing executions**, one
  ignored doctest (the library/binary unit targets each execute the same 170 tests).
- Focused final call-state/write-visibility run: **9 + 3 passing contracts**,
  including concurrent creation/capacity, identity forgery, canonical direct keys,
  real close/reopen with eight concurrent post-restart signals, unicast live/replay
  filtering, membership loss, same-account renewal and idle token revocation.
  Reopen uses the actual API router without the unrelated Socket.IO sweep task;
  all engine owners drop normally. No lock files are manually removed.
- `bun test src/lib`: **291 passed, 12 existing skips**, 878 assertions, including
  seven new deterministic call-client lifecycle tests.
- `bun run check`: **0 errors**, existing **181 warnings / 49 files**.
- `node scripts/call-state-browser-smoke.mjs`: passed in **headful Chromium under
  the real desktop CSP**, with production client/auth storage/refresh modules.
  Proves ACK-gated readiness, transient-refresh survival, same-socket renewal,
  reconnect, per-server refresh coalescing, legacy-token rejection, logout race
  protection and remembered-token revocation. Its network peer and server-selection
  boundary are fixtures; the real Rust HTTP/WS contracts are tested separately.
- `node scripts/audio-browser-smoke.mjs`: all three headful suites passed (real
  synthetic codec/local ICE path, settings, and actual call-entry admission
  denial/cancellation/coalescing). No physical microphone or speaker use.
- Web static and **Tauri frontend** builds passed, including standalone CodeMirror;
  no-addons server check and `git diff --check` passed. No new native package,
  deployed server, external Lore binary, or physical cross-network call tested.

Logs are local `/tmp/wabi-call-state-*`; they are not committed artifacts.

Upgrade compatibility: old `wabi_refresh_token:default` entries have no reliable
issuer/server binding. They are deliberately not transmitted or assigned to the
selected server. Those sessions need one fresh login when their access expires.
The `/ws` protocol and matching shared frontend must ship together.

Remaining lifecycle boundaries are explicit: persisted call rows are not live
media presence/device consent; abrupt-death cleanup, multi-device roster ownership,
and long-term signaling retention still need a separate design. This pass does
not implement durable group membership removal/account-wide media eviction or
consolidate every legacy admin/Socket.IO authenticator. No postcard/domain/event
schema changed; no projection rebuild migration or generated protocol edit needed.
