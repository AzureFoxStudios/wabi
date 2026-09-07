# Call admission boundary — 2026-09-07

Status: implemented locally; final verification recorded below. No deploy/push.

## Diagnosis and objective

The media transport is not the admission authority. Voice join/subscribe currently
write client-supplied channel IDs straight into the live roster. Relay admission
and P2P consent then trust that roster, including another device's stable account
ID. Group answers similarly insert nonmembers. A moderator kick removes roster
entries but leaves the kicked sockets in the relay room. These are concrete
authorization failures independent of microphone capture/codec correctness.

Complete the Socket.IO admission boundary: persisted live channel and kind,
current membership, connection-owned voice slots, confirmed client admission,
and server-owned relay eviction. Preserve primary/listener coexistence, correlated
relay acknowledgments, header replay, and shared browser/Tauri audio ownership.
Use existing records/events; live media and voice rosters remain ephemeral.

Verification: real Axum/Engine.IO/WabiDB negative and positive contracts, including
group answers, wrong-kind channels, unjoined sibling devices and relay eviction;
client admission state-machine tests; full server/frontend regression gates and
headful audio smoke. Report packaging/physical-device limits separately.

## Implemented behavior

Voice join/subscribe and group initiate/answer now check the live persisted
channel, its kind and the shared access policy. No empty-group fallback invites
the entire connected server. Relay channel admission rechecks durable access
as well as live consent. Direct-call UI channel hints remain distinct from
persisted channels and have a positive two-peer/negative-third-party contract.

Voice roster consent and device-addressed P2P signaling require the actual
connection, not another device on the same account. Authenticated sockets now
join their own socket-ID room: socketioxide did not do this automatically,
so socket-addressed kick notifications and peer signaling could silently miss
their recipient. Kick notification is additionally sent to exact SocketRefs.
Kicks evict relay rooms and cached headers under the roster lock; media enqueue
and relay admission hold read guards through their critical sections. Tests
inspect real server room membership, preserving the target's other call.

Primary/listener leave semantics remain independent. An irrelevant primary leave
no longer broadcasts a listener's departure. Bounded, connection-local intent
epochs prevent a pending voice authorization lookup from resurrecting a departed
or disconnected slot. Move requests cannot route private channels through the
global voice roster; the existing single-participant move notification path also
revokes its old relay room before notifying the client. This is not a complete
breakout authorization/ownership overhaul.

The shared browser/Tauri call entry awaits membership and a correlated voice
admission before microphone acquisition or media setup. Duplicate joins coalesce;
leave/kick cancels pending work; failed admission cleans its own session without
disconnecting an unrelated SFU call. Group answers previously attempted relay
setup **before** sending `call-answer`: they now await server group admission
first. A group P2P fallback without a connected peer no longer stamps the session
connected. No codec, DSP, postcard schema or generated protocol edits.

## Verification evidence

- Before: `/tmp/wabi-call-admission-before.log` — the new negative voice contract
  failed because the old handler never denied admission. The multi-device kick
  contract also exposed the missing socket-ID room notification path before that
  repair (`/tmp/wabi-call-kick-debug.log`).
- Real server: `cargo test -p wabi-server --features addons -- --test-threads=1`
  passed **397 test executions**, with one ignored doctest. Includes **13 channel
  access contracts** (four new call contracts), **13 Lore credential contracts**,
  and existing audio units. Log: `/tmp/wabi-call-admission-server-verified.log`.
- No-addons server check passed: `/tmp/wabi-call-admission-no-addons.log`.
- Frontend: **284 passed, 12 existing crypto skips**, 850 assertions. Type check:
  **0 errors, 181 existing warnings in 49 files**. Logs:
  `/tmp/wabi-call-admission-frontend-verified.log`,
  `/tmp/wabi-call-admission-check-verified.log`.
- Headful Chromium under the real desktop CSP: actual codecs/worklets, local
  bidirectional P2P media, mute/replacement/handover, real audio-settings component,
  and actual `joinVoiceChannel`/`leaveVoiceChannel` entry-point tests. Denial during
  HTTP membership or socket admission, cancellation during either stage, duplicate
  clicks and waiter/session/mic cleanup are covered. No physical mic access.
  Harness: `node scripts/audio-browser-smoke.mjs`; final log
  `/tmp/wabi-call-admission-browser-complete.log`.
- Static web and Tauri frontend build logs:
  `/tmp/wabi-call-admission-static-build-verified.log`,
  `/tmp/wabi-call-admission-tauri-build-verified.log`. These are frontend builds,
  **not a new native Linux executable or distributable package**.

The browser admission harness uses fixture HTTP/socket boundaries; the server
contracts use actual Axum, Engine.IO and a temporary WabiDB. Neither alone proves
two deployed clients across NAT/TURN, LiveKit, native WebKitGTK or physical audio
devices. Those remain release gates. No live data, host packages, running
deployment, credentials or Git remote were changed.

## Next launch gates (not completed by this objective)

The separate `/ws` call-state path accepts unauthenticated subscriptions and
client-forged broadcasts; REST call sessions lack resource authorization. Repair
them together with the reconnecting `WabiDbCallState` client next. Also still
required: durable group add/leave/kick with account-wide receive eviction; unified
session/admin credential checks; operator remediation of historical instance-key
exposure; real cross-network calls and packaged Tauri user journeys. Existing
honest NOT_IMPLEMENTED group-membership responses remain until their whole
lifecycle is implemented. No new launch date is promised from build results.
