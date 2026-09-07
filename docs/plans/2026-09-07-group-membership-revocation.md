# Durable group membership and account-wide access revocation

Status: in progress. No membership fix is deployed yet.

## Objective and authority

Finish group creation/add/kick/leave as one lifecycle: durable WabiDB changes,
truthful acknowledgments and client reconciliation, all-device receive eviction,
and rejection of stale admission/reconnect work. Preserve existing audio,
browser/Tauri behavior, optional Lore boundaries and unrelated working changes.
The user's subsequent authorization permits committing/pushing and deployment
to Tim, including necessary Wabi restarts. Deployment requires tested artifacts,
a consistent backup, rollback and post-deployment verification. No host package
installations, destructive resets, security bypasses or subagents. Physical
Android checks wait for the user; ironin availability is not a local-work gate.

## Source-backed diagnosis

The previous channel boundary deliberately replaced fake-success group handlers
with NOT_IMPLEMENTED. Membership removal itself now projects and replays, but
existing Socket.IO room membership is not revoked by changing the projection.
Group-call consent is a separate account set; persisted call participants and
raw-WebSocket subscriptions are a third boundary. All must respect removal.

`on_join_channel` checks access before several awaits and then joins the room.
`on_join` builds a private-channel snapshot across awaits before emitting init.
Both can race a membership transition. Group call initiate/answer similarly
check membership before writing their live session. Eviction must coordinate
with these admissions, not race a sequence of independent checks and inserts.

`upsert_group` writes a channel with owner 0, then each member in a separate
command. The UI guesses the owner from array order, while the membership query
does not promise join order. The avatar HTTP handler also calls this destructive
upsert. Creation must publish a complete group with a real owner, never rewrite
group metadata as a side effect of an unsupported avatar operation.

Frontend group helpers resolve immediately after socket emit (or offline enqueue),
and group settings closes on leave without acknowledgment. Incremental membership
events have no corresponding listeners in the current socket bootstrap. These
are unfinished behavior, not just missing persistence.

## Design decisions under implementation

- Group ownership is explicit for new groups. Legacy owner-0 groups can recover
  the creator from oldest persisted join time (stable user-ID tie-breaker), not
  online presence or incidental index iteration order. Owner departure transfers
  to a remaining member durably; leaving the last member retires the group.
- Group administration requires current private membership; instance ownership
  is not permission to enter or administer a stranger's conversation.
- Batch membership changes and channel ownership/creation share one command.
  Current AES-GCM nonces allow one event per stream per command, so multiple
  changes to the membership stream need one batch event, not repeated events on
  that stream. Existing postcard records stay unchanged.
- Coordinate membership writes with admission and snapshot publication using
  an explicit server-owned gate. No network acknowledgment from an evicted
  client is required to revoke server-mediated access. Already delivered content
  and malicious peers' existing direct P2P connections cannot be recalled.
- Membership actions need correlated application acknowledgments and honest
  pending/failure states. Delayed joins, stale snapshots and queued work must
  not resurrect removed access or erase a later deliberate re-add.

## Verification and progress record

Use actual temporary WabiDB, Axum/Engine.IO and raw WebSocket contracts for
authorization, concurrent transitions, all-device eviction, reconnect, and
restart/replay. Headful browser tests must exercise production group helpers,
state reconciliation and UI, not only pure mock state machines. Run broader
server/database/frontend tests, audio smoke and web/Tauri frontend builds;
distinguish these from native packaging and physical-device audio verification.

Reconnaissance completed against current worktree and recent history. Prior
Lore/channel/call security edits and separate UI-lane documents are preserved.
At reconnaissance, persistence, live lifecycle, frontend behavior, full
verification and deployment were incomplete. Progress checkpoints below supersede
that baseline. The goal remains active until the paired client and deployment
verification are complete.

### Persistence implementation checkpoint

The first real-adapter regression reproduced owner 0 instead of creator 9
(`/tmp/wabi-group-membership-before.log`). Replaced `upsert_group` with explicit
create/change commands. Group creation submits channel metadata and one complete
membership delta together; changes submit membership plus owner succession or
last-member channel deletion together. Both await whole-command application and
then use the existing subscription delivery boundary. No direct projection writes
or new parallel membership persistence in application code.

Projection/domain contract change: added `channel_members_changed` with a new
JSON payload (`channel_id`, `upserts`, `removals`) while preserving all historical
postcard records/events. The handler validates the whole delta before touching
indexes. Existing `channel_updated` now applies the already-existing JSON owner
field. Membership events write the `channel_membership_versions` secondary index
(channel ID → eight-byte LE commit sequence); legacy checkpoints start at zero
until the first post-upgrade membership event. List queries propagate corruption.
Targeted legacy snapshot repair handles the new batch's add/remove decisions.
Relevant projection/store skills updated using skill-creator guidance.

Found and removed the remaining HTTP avatar upsert: it wrote an orphan file,
rewrote group ownership/name and globally broadcast a URL without durable avatar
storage. That endpoint now returns authenticated 501 before file/state writes,
matching the already-disabled socket avatar operation. This is protection of the
membership aggregate, not completion of avatar support.

Upgrade/rollback caveat: an old binary does not understand the new batch event.
Deployment must retain a consistent pre-upgrade data backup and use an updated,
event-compatible binary for data-preserving rollback after new writes. Never
blindly downgrade the binary against a database containing new events, or restore
an old backup over later real-user writes. Final deployment procedure remains to
be verified before any live mutation.

The creation regression now passes, as do the five existing channel lifecycle
contracts and ten membership projection units. Expanded delta/succession/replay
and legacy-checkpoint regressions pass. Checkpoint verification:

- `cargo test -p wabidb --lib`: 901 passed (`/tmp/wabi-group-database-checkpoint.log`).
- `cargo test -p wabi-server --features addons --test group_membership_contract
  --test channel_lifecycle_contract --test channel_access_contract
  --test lore_credential_contract --test call_state_contract`: 45 passed
  (`/tmp/wabi-group-security-checkpoint.log`). Includes real HTTP proof that the
  unsupported avatar path creates no file or group/projection change.
- Both edited skill validators and `git diff --check` passed. No generated
  protocol, native build files, frontend UI or live host changed in this checkpoint.

At the persistence checkpoint, live eviction, application admission coordination,
client acknowledgments and UI/reconnect behavior were unfinished; the three
mutation handlers still returned NOT_IMPLEMENTED. The server checkpoint below
replaces those handlers with the versioned command protocol.

### Next implementation boundary traced

Server socket rooms are exact channel IDs, `wb:{id}` / `wb:channel:{id}`, and
`wabidb-call-channel:{id}`, plus account and device addressing rooms. Eviction
must enumerate authenticated SocketRefs, not just `connected_users` (a device
can authenticate/admit before publishing presence). Preserve its unrelated calls.
The raw WS checks current membership at delivery but also needs prompt removal
of its subscription/client cache on revocation. Persisted call participants must
not regain old consent merely because the account is later re-added.

Group create/answer/relay joins and peer signaling have check→await→publish gaps;
coordinate these with the membership writer. Initial `init` publication must be
ordered with incremental membership snapshots. Normal REST private self-join is
already forbidden; REST conversation creation is also rejected in favor of the
conversation flow. Generic Socket.IO channel-settings, pin/unpin, thread creation
and whiteboard cursor paths need a scoped recheck during this receive/write audit.
Their current presence in the source is not proof of membership authorization.

`frontend/src/lib/wabidb/drain.ts` still marks group queue entries synced immediately
after emit. The membership workflow must not inherit that success claim or blindly
replay stale add/kick/leave intent. Pending group settings/DM navigation currently
does not wait for an acknowledgment. Preserve shared audio entry/cancellation and
the actual root `src-tauri/` configuration while adding that client boundary.

### Server lifecycle implementation checkpoint

`socketio/group_membership.rs` now owns admitted creation/add/kick/leave. Active
registered membership and group ownership—not instance-admin privileges—authorize
mutations. New `AppState.membership_gate` orders the full transition against all
stateful Socket.IO dispatch, including initial discovery, history/room admission,
whiteboard, group-call initiation/answer, relay enqueue and peer signaling. REST
call routes take the reader before their striped session locks. The writer owns
validation, whole-command application, live eviction and publication. Helpers
must never recursively take this gate: Tokio's queued writers are fair. Live
voice/group locks keep their existing order inside it. Raw WS reads/snapshots
use the gate but release guards before bounded network writes.

The group command appends existing `call_participant_left` JSON events for the
removed account's active rows in every associated call (including ended calls).
Last-member leave retires all remaining participant rows and ends active sessions
in that same command. No call record/codec changes. The typed
`list_channel_call_sessions` query scans and validates the call-session projection;
corruption fails the command before committing membership changes. No new call
secondary index/backfill. A remaining group owner can end a call whose original
host is no longer a member; no equivalent instance-admin or ordinary-call bypass.

Live eviction enumerates authenticated `SocketRef`s rather than relying on presence
or account-room publication, so devices admitted before `join` are included.
It removes exact group chat, both board room spellings, and relay rooms; removes
the account from invited/connected group-call sets; forgets only matching relay
headers; and notifies each device. Group peer departure uses the same stable
account ID as group join, with device IDs supplied separately; mixing those IDs
would leave remaining clients' account-keyed P2P participants behind. Unrelated
voice listening, peer addressing and calls remain intact. Raw WS gets a versioned internal `CallAccessRevoked` push,
translated to `subscription_error` only for that account. Its subscription map
records the admission membership revision: a quick re-add cannot silently preserve
the old subscription, and a delayed old removal cannot erase a newer explicit one.

Wire contract for the paired frontend (still to implement):

- Creation uses `create-group {requestId: UUID, groupName, userIds}`. The request
  UUID defines a stable group ID for lost-ACK retries. Used/deleted group IDs
  cannot be resurrected; a same-owner retry returns the current existing group.
- Add/kick/leave use their existing event names and target fields (`userId` for
  add, `targetUserId` for kick), plus `requestId: UUID`, `channelId` and
  `expectedRevision: decimal string`. A stale revision returns CONFLICT and a
  current snapshot to that still-authorized requester, with no new mutation.
- `group-operation-result` correlates requestId, operation (`create/add/kick/leave`)
  and channelId. Success has `ok:true`, membershipRevision and current channel
  (null for retired group). Failure has `ok:false`, code and error. A persistence
  failure instructs refresh before retry; it does not promise nothing committed.
- Group snapshots in init/create/add/update contain explicit `ownerId`, persisted
  `members` and `membershipRevision`. Revisions are strings to preserve u64
  precision. Legacy checkpoint revision 0 remains a valid baseline.
- `group-membership-updated {channelId, channel}` goes to remaining accounts;
  a new member additionally receives group-channel-added. Updates do not force
  server room joins. `group-removed {channelId, membershipRevision, reason}` goes
  directly to every removed device before command acknowledgment.
- Legacy unversioned group mutations fail visibly; old offline entries must not
  be marked successful or replayed under a different server/account. Avatar
  operations stay unsupported. Do not deploy the backend without the new client.

The adjacent private-write audit also closed group bypasses in Socket.IO thread
creation, pin/unpin, channel settings/reordering and whiteboard cursor fan-out.
Pin notifications target the requesting account instead of broadcasting private
channel IDs. Shared settings/reordering cannot mutate private conversations.

Verification added in this checkpoint:

- Real-adapter membership tests cover atomic call cleanup, checkpoint/replay,
  later re-add, final retirement, unrelated-call preservation, and corrupt call
  projections rejecting the whole operation. Existing legacy batch repair remains.
- Six real Engine.IO/Axum/raw-WS cases cover owner-only administration (including
  outsider instance owner), competing tabs, multi-device eviction including a
  presence-less device, actual room delivery exclusion, surviving unrelated
  voice receive, queued/in-flight chat joins and REST call admission, reconnect
  discovery, creation retries, owner succession, final leave, adjacent write
  denial, and prompt/versioned raw-WS subscription revocation.
- A deterministic ownership unit covers explicit owner, legacy chronological
  fallback, missing-owner recovery and tie-breaking independent of index order.
- The first multi-device test waited for a nonexistent whiteboard:document event;
  corrected to the production whiteboard:joined contract. A raw-WS fixture import
  was corrected to the existing `futures` dependency. No dependencies added.

Client implementation, headful browser/audio regression, static/Tauri builds,
upstream reconciliation, consistent deployment backup/rollback, push and live
deployment verification remain unfinished. No host packages, credentials, live
data or services changed in this checkpoint. No native Linux package was built.

Final server-checkpoint verification:

- `cargo test -p wabi-server --features addons -- --test-threads=1`: **421 test
  executions passed**, zero failed, one ignored doctest. Includes the same 171
  unit tests compiled in lib and bin, so this is not 421 unique tests. Twenty
  channel-access contracts include the six new live lifecycle cases; six
  membership persistence contracts, nine call-state and thirteen Lore credential
  contracts passed. `/tmp/wabi-group-server-checkpoint-final.log`.
- `cargo test -p wabidb --lib`: **901 passed**, zero failed.
  `/tmp/wabi-group-database-live-checkpoint.log`.
- Both updated WabiDB skill validators and `git diff --check` passed. The
  no-default-features server check also passed after final wire review:
  `/tmp/wabi-group-no-addons-checkpoint.log` (existing warnings remain).

Next bounded implementation step: use these actual wire fields in the shared
browser/Tauri client. Group helpers must wait for correlated application results,
fail honestly while offline/disconnected, and bind pending work to the exact
server/account/socket. Reconcile versioned membership snapshots and removal
tombstones across init, late history, async joins and persistent offline storage;
do not mark old unversioned queue entries successful. Removal must clear the
group's UI/navigation/message/call state without ending unrelated listening or
calls. Specifically test revocation while async call entry/import work is pending.
GroupSettingsPanel needs Svelte 5 runes, explicit owner authority, pending/error
states and offline registered-member choices; the DMTab leave entry must also
await acknowledgment. Unsupported avatars remain disabled. Headful UI/audio and
static/Tauri verification come after that client work, before push/deployment.

## Client command/UI checkpoint — 2026-09-08

The shared browser/Tauri group controls now use the server contract above.
Create/add/kick/leave await `group-operation-result`, validate the matching
request/operation/channel/revision/snapshot, surface server denials, and distinguish
lost confirmation from a confirmed rejection. They never buffer membership
changes offline. Concurrent duplicate helper calls coalesce on one socket;
uncertain creation retains its UUID for an explicit retry. Socket teardown
cancels waiters before removing listeners. Group avatars remain unsupported.

`groupMembership.ts` maintains account/server-scoped versioned snapshots and
persisted tombstones. Revisions stay decimal strings through u64 comparisons.
Async leases capture runtime realm generation and group lifecycle epoch: switching
A→B→A or removing/re-adding cannot revive old work. Another member's ordinary
roster change does not interrupt this account's valid lease. Init reconciles
missing groups; old socket callbacks, stale grants, and removed-group content are
fenced. The shared HTTP join path checks leases after awaits and before room emit.
Changing context to a guest also clears the previous account's group surfaces;
that is not a new realm's authorization or a fabricated server tombstone.

`groupClientState.ts` removes only the affected group's navigation/selected panel,
message/unread/typing/roster/archive-pagination/history-pagination stores. An
unrelated center DM, public message canary and voice roster survive. Group settings
and creation use Svelte 5 runes, explicit owner ID, the registered/offline directory,
pending/inline errors and disabled duplicate controls. Keyboard removal is usable;
unsupported upload controls were removed. A headful test caught a real post-leave
exception when Svelte removed the panel's prop before its receipt resolved; async
callbacks now tolerate that teardown.

The real IndexedDB queue now stamps new intent with server/account context before
storage awaits, and group content with its exact membership revision. Group content
waits for init. Legacy unscoped content/membership operations and mismatched group
epochs are failed non-retryably, never adopted into a new account or re-add.
Other-realm entries defer. New valid group content can still be queued offline.

Review found a coupling worth recording: `messages.rs` echoes clientMessageId but
does **not** durably deduplicate it. Consequently queued messages now atomically
claim one `attemptedAt` before emit, across independent IndexedDB connections,
then recheck connection/access. Uncertain attempts are not automatically resent,
even by the generic Retry button. Only a matching server message receipt marks a
message synced; atomic status changes prevent a late timeout undoing that receipt.
This is not a new server-side idempotency guarantee. In particular, the existing
server message handler still warns/continues if `send_message` fails: that separate
message persistence-acknowledgment defect must be addressed before broad launch
readiness can be claimed. Non-message legacy queue dispatches retain their older
emit-completion semantics; do not describe the whole offline layer as complete.

Verification so far in this checkpoint:

- Focused pure receipt/membership/HTTP tests passed; the broader frontend suite
  passed 306 tests with 12 pre-existing skips before the final context-reset test
  was added. A final rerun is recorded below.
- `group-membership-browser-smoke.mjs` passed in real headful Chromium under the
  root Tauri CSP, using production UI, SocketManager, credentials, queue and state
  modules with controlled transport peers. It covers pending/denied/retry/add,
  keyboard kick, leave-before-receipt teardown, unrelated-state canaries, stale
  content/grants, lost creation receipts, actual IndexedDB claims and no unsafe
  retry, suspended HTTP join across removal/re-add, stale socket callbacks, and
  missing init. A 390px viewport check is not physical Android testing.
- Existing headful channel-access, call-state, Lore credential UI and audio
  scripts all passed. Audio covers real synthetic bidirectional P2P ICE/media,
  relay microphone/screen tones, mute/input replacement, room loss/rejoin,
  duplicate receiver suppression, DSP and voice-admission cancellation. No real
  microphone/speakers or live accounts were used. The audio fixture produced
  existing 404/a11y notices and expected denial/cancellation logs.
- Typecheck passed with zero errors and 181 existing warnings; static and Tauri
  frontend builds passed before final context-reset changes. Final reruns below.
- Frontend architecture/offline skills updated: corrected stale claims that all
  actions are safe to queue, SQLite was deleted and Svelte window attributes
  require legacy syntax. The interface-polish skill guided existing-token/plain
  CSS pending/error cues, keyboard visibility and touch targets, not a redesign.

Still required in this same goal: synchronous revocation of active/pending group
calls, no delayed capture/import/transport resurrection, preserved unrelated
primary/listen-only sessions, raw-call cached-state cleanup and WabiDB relay
teardown/rejoin fencing; persistent chat archive purge and late-load/write fencing;
the combined removal-during-call browser cases; final diff/security/compatibility
review; upstream reconciliation and authorized paired push/deploy with consistent
backup/rollback and both lock owners checked. No commit/push/deploy or native
Linux package was produced in this checkpoint. No host packages/services/live
data were changed. The separate user UX-scout documents remain untouched.

Final client command/UI checkpoint verification (after context-reset and queue
claim review):

- `bun test src/lib`: **307 passed, 12 skipped, zero failed**, 45 files;
  `/tmp/wabi-group-frontend-tests.log`.
- `bun run check`: **zero errors, 181 warnings** in 49 files;
  `/tmp/wabi-group-client-check.log`.
- Group headful script: **passed**, including the final logout-to-guest canary;
  `/tmp/wabi-group-browser.log`. Separate existing channel/call/Lore/audio headful
  scripts passed in the sequential broader browser run.
- `bun run build:static` and `bun run build:tauri`: **passed**;
  `/tmp/wabi-group-static-build.log`, `/tmp/wabi-group-tauri-web-build.log`.
  These are frontend builds, not a native Linux installer; the last build leaves
  Tauri-targeted frontend output, so regenerate the static build before embedding
  a future server binary.
- Both updated skill validators passed. The offline skill's existing legacy
  author/version/platform frontmatter was moved under metadata to retain it in
  the supported schema. `git diff --check` passed; semantic group/UI/queue/socket
  diffs reviewed. No background browser/test/build process remains from this run.

Immediate continuation: call lifecycle and archive fences listed above. Avoid
another general reconnaissance pass; the client command/UI layer is implemented
and verified, not the remaining call/storage lifecycle. The old history request
helper emits `load-history` but SocketManager currently has no `history-loaded`
listener; record that separate pre-existing completeness gap instead of assuming
history pagination already has a complete receive path.

Call investigation handoff (no additional call-code changes in this checkpoint):
`startGroupCall`/group `answerCall` acquire shared mic/camera without a cancellable
group owner; `enterEstablishedGroupCall` and participant-joined can resume after
transport awaits, and the latter can establish without confirming a matching
local outgoing/active group. Existing `teardownCallSessionOnly` falls back to full
teardown when there is no *primary* voice ID, which also kills unrelated listen-only
sessions. Do not use it blindly for revocation. Group lifecycle cancellation must
be synchronous, target matching peers/session only, and fence late shared-capture
callbacks without cancelling another live/pending voice consumer. Camera streams
obtained after cancellation must be stopped before attaching them. Keep cleanup
generation-owned so an old rejected attempt cannot destroy a new call.

`disconnectWabidbChannel` deletes sessionIds only AFTER awaiting leaveSession;
a quick new connection can therefore be erased by the old leave completion.
Move ownership changes before awaits or compare captured identities. Its connect
coalescing/finalizer and rejoin await paths also need matching lifecycle guards.
SocketManager already captures membership leases before group-related lazy
imports, but that does not protect subsequent awaits inside calling itself.

## 2026-09-08 — owned group-call admission and revocation checkpoint

Implemented and verified in this continuation (not deployed):

- One local group-call owner/controller spans pending start/answer, capture and
  active call. Duplicate starts share the same promise. Removal/realm change
  retires it synchronously. Old failed attempts cannot clear a new call, and
  participant notifications cannot establish a call without matching local
  intent. Incoming group offers wait for capture readiness.
- Group initiation now ACKs `group-call-started {channelId,requestId,established}`
  after server consent and before invitations/peer notifications. Both start and
  answer wait for correlated admission before capture. Existing-group start
  notifies connected peers and enters a real group session, including with an
  already active voice backdrop. Group cancel/leave invalidate pending admission
  epochs. The generic waiter handles server `message`, malformed unrelated
  replies, synchronous emit failure and cleanup exactly once.
- Revocation tears down only matching peer/session/relay state and newly owned
  camera tracks; shared capture survives unrelated primary/listen-only sessions.
  Late initial microphone/camera permission results are disposed. Broadcast
  transmit mode cannot bypass removed-group gating. Group peer-offer creation
  cannot accidentally start an unrelated DM relay; fallback and transport
  selection cannot publish success after owner cancellation.
- WabiDB relay teardown removes local maps/aliases/controllers before HTTP
  awaits. In-flight finalizers, async imports, room joins/rejoins and watchdog
  recovery honor captured ownership/access. Explicit teardown stops its watchdog;
  a watchdog's own transport transition retains recovery. LiveKit setup gained
  cancellation/generation checks and rejects ownership conflicts rather than
  disconnecting another call; no live LiveKit server was exercised.
- Group relay create/join/leave pin `membership_revision` through auth retries.
  The server compares supplied decimal u64 revisions under its membership gate,
  before writes/no-op responses. Old requests receive 409 after remove/re-add;
  legacy omission still uses full prior scope checks. No postcard changes.
- Raw call revocation retires subscription identities and cached rows; old
  handles cannot unsubscribe a new subscription, and older revocation revisions
  do not clear a newer snapshot. Unrelated session subscriptions remain.

Proof at this checkpoint:

- `bun test src/lib`: **312 passed, 12 existing skips, zero failures**, 45 files,
  996 assertions; `/tmp/wabi-group-call-all-unit.log`.
- `bun run check`: **zero errors, 181 existing warnings**, 49 files;
  `/tmp/wabi-group-call-owner-check.log`.
- Full addons server suite passed; `/tmp/wabi-group-call-server-all.log`.
  New real Axum/WabiDB contract proves stale-revision create/join/leave cannot
  affect a re-admitted account; actual Engine.IO contract verifies group start
  ACK, outsider denial and existing-group peer notification.
- Headful `audio-browser-smoke.mjs`: all five routes passed;
  `/tmp/wabi-group-call-browser.log`. Existing bidirectional synthetic P2P and
  relay mic/screen/DSP checks still pass. New production-entry harnesses prove
  denial-before-capture; remove/re-add during permission, camera and SDP;
  unrelated listener/peer/capture preservation; established-group admission;
  no unsolicited participant-event resurrection; and real relay setup races
  during REST create, HTTP leave and Socket.IO room admission. Network peers and
  the background session model are fixtures, not physical two-device proof.
- Broader headful group/UI, channel-access, call-state and Lore checks, static/
  Tauri frontend builds and final diff/skill validation are being run below.

Still required before this goal is complete or deployment-ready:

1. Finish the adjacent camera-toggle and screen-picker/signaling lifecycle.
   Initial camera acquisition is now owned; `toggleVideo`, `wabidbStartVideo`
   and `callingScreenShare` still have separate capture awaits. A removed group
   must not publish a late picker result, leave its camera live while a listener
   survives, or route group video/screen audio through another call's shared
   video lane. The relay's single video-lane ownership needs careful treatment
   without destabilizing working microphone/receive relays.
2. Review reconnect recovery/renegotiation beyond the tested start/removal
   paths, especially delayed SDP/ICE callbacks and consent restoration for an
   established group. Extend regression coverage where these async paths cross
   membership epochs; do not reopen the finished command/UI implementation.
3. Purge persistent chat archives for removed groups and fence late loads/writes.
   The existing in-memory clear is not enough. Preserve other conversations.
4. Combined final security/diff review, then reconcile upstream and perform the
   explicitly authorized push/deploy with consistent backup/rollback and both
   lock owners checked. No commit/push/deploy, host install or live-data change
   occurred in this checkpoint. Native Linux installer, native WebView and
   physical Android/two-device verification remain unproven.

Keep the separate message persistence-ACK defect and missing history receive
handler recorded above distinct from this goal; do not imply launch readiness
while those known product issues remain. User UX-scout files remain untouched.

Final checkpoint review also moved raw-call disconnect before network leave
awaits, ignored an obsolete call-state instance's disconnect callback, and delayed
watchdog ownership publication until the relay is ready. A pending group relay
must not hijack another channel's watchdog merely by constructing its encoder.

Broader verification completed: **422 passing server test executions** (includes
the duplicate library/binary suites), zero failed, one ignored doctest. All four
additional headful scripts passed: `/tmp/wabi-group-call-ui-browser.log`,
`/tmp/wabi-group-call-access-browser.log`, `/tmp/wabi-group-call-state-browser.log`,
`/tmp/wabi-group-call-lore-browser.log`. Static and Tauri frontend builds passed;
their logs are `/tmp/wabi-group-call-static-build.log` and
`/tmp/wabi-group-call-tauri-build.log`. The final relay identity review is followed
by another audio/unit/typecheck/build rerun before handoff. Both updated skill
validators and `git diff --check` passed. No server/WabiDB codec files changed in
this call checkpoint; the previous 901-test WabiDB run still applies to the
unchanged database implementation.

Final rerun **completed successfully after the relay identity review**: all five
audio routes, 312 frontend tests (12 skips), zero-error typecheck (181 warnings),
static build and Tauri frontend build. Every test/browser/build process launched
in this continuation has terminated; no background task is being left running.
The last build output is Tauri-targeted: regenerate static assets before the
eventual Rust server embed. Goal remains active; the next pass starts with the
remaining camera/screen/reconnect ownership paths listed above, not another
general reconnaissance or repeat of the finished group command/UI work.

## Video/screen ownership checkpoint — 2026-09-08

Push and deployment are now explicitly authorized for this goal, including
while the user sleeps, superseding the attachment's original prohibition.
Neither occurred in this checkpoint. No host packages, services, live data or
remote machines were changed.

Confirmed failures and implemented corrections:

- The singleton video lane belonged to whichever relay connected first; same-
  user feeds collided across calls. Per-session lanes now own reassembly,
  decoders and previews; outbound camera/screen each have an explicit destination
  and cancellable generation. Late codec completion cannot restore removed media.
  Actual emission requires the owning relay's admitted room. Mic ownership stays
  independent, including background listen-only calls.
- Screen signaling selected all active call relationships. Server audience and
  SDP/ICE checks now require the exact group/voice scope (or direct call link),
  and preserve channel/request identity. Background voice consent cannot authorize
  group SDP; stale membership revisions are rejected. Recording is unchanged.
  Old unscoped screen starts are refused: paired ship + old-client reload needed.
  No postcard/event schema changed in this pass.
- Display and camera permission reserve a local owner before awaiting. Removal
  disposes late tracks and matching peers without clearing replacement media or
  background audio. Screen start awaits correlated server audience admission;
  denial, timeout, cancellation and disconnect release capture, not fake success.
  New background peers cannot inherit a foreground group camera from localStream.
- Early ICE parking remains, now retaining scope/share guards through delayed
  peer creation and ending a drain on replacement. `callingIce.ts` isolates the
  queue from mediaRuntime/browser globals; this also fixed an import-order test
  dependency exposed by the full suite, without browser-global test mocks.
- CallStage/VoiceView and modal/strip selectors use session-owned feeds and
  previews. Real Svelte stages verified two different streams from the same user
  in two calls; removing one preserved the other. Existing styling and runes
  architecture retained: this is data selection, not a visual redesign.
- Without WebCodecs, video chooses P2P while audio remains relayed. This capability
  branch was tested with VideoEncoder unavailable in Chromium, not WebKitGTK.
  Installed LiveKit source confirms setScreenShareEnabled awaits/returns its
  publication, so the global-room polling fallback was removed in favor of that
  owned result. Actual SFU runtime behavior is not claimed verified.

Final-source verification:

- Full addons server suite: **423 passing test executions**, zero failures,
  one ignored doctest; `/tmp/wabi-group-video-server-all.log`. Real Axum/WabiDB/
  Engine.IO channel suite adds simultaneous group/voice audience, all six SDP/ICE
  message forms and stale revision checks (21 tests in that suite).
- Frontend: **320 passed, 12 existing skips, zero failures**, 47 files and 1,028
  assertions; `/tmp/wabi-group-video-all-unit-final.log`.
- Typecheck: **zero errors, 181 existing warnings** in 49 files;
  `/tmp/wabi-group-video-check-final.log`.
- All five headful media routes passed under desktop CSP;
  `/tmp/wabi-group-video-browser-verified.log`. Actual generated tracks, RTC/SDP,
  codecs/envelopes and Svelte rendering prove camera/picker cancellation,
  denied-screen cleanup, correct video destination, no post-removal video and
  preservation of background mic/relay/tile. Existing bidirectional synthetic
  P2P, relay mic/screensound, DSP and audio settings checks still pass.
- Group UI, channel access, call-state and Lore headful checks also passed;
  `/tmp/wabi-group-video-{ui,access,state,lore}-browser-final.log`. These four
  final sequential checks completed without overlapping builds.
- Tauri frontend and static builds passed;
  `/tmp/wabi-group-video-tauri-build-final.log` and
  `/tmp/wabi-group-video-static-build-final.log`. **Static output is last** for
  future server embedding. No native Linux installer was built.
- WabiDB source did not change this pass; previous engine checkpoint is 901
  passing tests. Rerun it at the final combined goal gate.

Not proven: two authenticated physical clients across NAT/TURN, actual LiveKit,
native Tauri WebView/installer, physical Android. Browser network peers are
fixtures, with real media and rendering as described above.

Remaining goal work: established-group reconnect/readmission (owner still pins
original socket ID), persistent archive purge and late read/write fences, final
combined replay/security/diff review, upstream reconciliation and staging only
this work, then authorized push/deploy with consistent backup/rollback and both
lock owners checked. The separate message persistence-error path still emits
message/accepted after logging failure, and the missing history-loaded listener
remain separately recorded launch defects, not claimed fixes. User UX-scout
documents remain untouched.

Verification discipline: a later media rerun overlapped the frontend rebuild.
Vite reloaded the harness mid-test and the run timed out (preserved in
`/tmp/wabi-group-video-browser-final.log`); this is not a passing run. The media
suite was rerun separately after every build process exited, with results in
the `-browser-verified.log` path above. Frontend skill validation and
`git diff --check` passed. Codec errors remain visibly reported, throttled and
identity-checked so an old lane's delayed notice cannot affect a replacement.

The clean final media rerun completed successfully: all five routes passed,
including the new camera, screen admission and rendered call-stage cases.
All test/browser/build processes from this continuation have terminated. No
push or deployment has occurred; the goal remains active for reconnect and
archive fencing, followed by the combined release gate described above.

### Established-call reconnect checkpoint (2026-09-08)

Confirmed two coupled defects: SocketManager replaced Socket.IO objects while
relays and video lanes retained the old object; server group consent was only
account-owned, so an unadmitted sibling or old socket disconnect could evict the
calling/replacement device. Existing unconditional room rejoin/roster self-heal
could not rebuild the bound transport and did not await actual consent.

Implemented device-owned ephemeral group admission, quiet revision-pinned
readmission, last-device departure semantics and account-wide membership
eviction. No postcard/domain/projection changes in this checkpoint. Server
regressions use real Axum/WabiDB/Engine.IO, including handshake-only devices,
overlapping old/new socket admission and an initially empty runtime roster.
The empty-roster test is not represented as a process-restart test.

Client call owners now receive synchronous socket retirement before listener
removal and readmit after authoritative init, independently of the offline
queue. Established group recovery creates a fresh owner/controller and pins the
original membership revision. Any changed revision requires explicit rejoin;
late old replies cannot activate media or clear replacements. Old relay/peer/
video state retires locally, without an account-level HTTP leave racing the new
same-revision join. Screen capture stops; microphone capture/mute/focus/volume
remain owned by retained calls. Primary/background voice readmit independently.
Removed obsolete room rejoin and roster-created media paths.

The broader call trace found primary voice leave used `leaveAll` despite keeping
other media alive. It now removes exactly its session and preserves group/
background relays and shared capture. Browser startup also exposed a genuine
presence/user-lookup barrel cycle after obsolete imports disappeared: identity
stores now live in a small dependency-leaf module, re-exported as the same store
instances. Added a pure lookup regression and reran actual browser entrypoints.

Verification so far:

- Full addons server suite: **429 passing test executions**, zero failures,
  one ignored doctest; `/tmp/wabi-group-reconnect-server-all.log` (173 unit tests
  in each lib/bin target; 23 channel-access contracts). Process completed.
- All six headful media routes passed; `/tmp/wabi-group-reconnect-browser-all.log`.
  New reconnect route uses production owners, real capture/encoders and fixture
  HTTP/Socket.IO/raw WebSocket. It proves new-socket encoded group audio, no old
  emission, admission-before-media, repeated disconnect, offline revision change,
  per-session state retention and scoped primary leave. Existing P2P bidirectional
  media, relay/DSP, camera/screen and rendered call-stage checks passed too.
- Earlier runs intentionally retained as failure evidence: `-browser.log` and
  `-browser-debug.log` exposed the user-lookup initialization cycle;
  `-browser-debug2.log` had an incomplete fixture membership response;
  `-browser-debug3.log` had an overbroad assertion counting legitimately admitted
  voice rooms as the pending group's room. These are not passing runs. Corrected
  production cycle and fixture assertions; `-browser-debug4.log` and the full
  `-browser-all.log` above passed. Final broader check/build results follow below.

Remaining: persistent archive purge/late cache fences; combined replay/security/
diff/upstream review; authorized push and deployment with consistent backup,
rollback and both lock owners checked. Direct-call reconnect, account-level
persisted participant aggregation across devices, and multi-device P2P's legacy
peer-key model are not claimed solved by device-owned ephemeral group consent.
Physical clients/NAT/TURN, native Tauri WebView/installer and LiveKit runtime
remain unverified. No deployment or push yet. The goal remains active.

Follow-up wiring review found that the actual sidebar listener API depended on
the removed roster self-heal. Replaced its raw subscribe/unsubscribe with owned
call joins (explicit listen-only option), scoped leaves and offline cancellation
even while SocketManager has no socket. New voice queue actions are rejected;
legacy join/leave/subscribe/routing rows fail permanently instead of competing
with fresh readmission. Recovery republishes current routing mode. Join clicks
during recovery coalesce; focused offline leave can select a retained reconnecting
session without labeling its media connected. Added policy, session-model,
actual-sidebar-API and real IndexedDB queue coverage. These edits supersede the
earlier frontend build checkpoint until the final gates below complete.

`/tmp/wabi-group-reconnect-browser-sidebar.log` timed out inside the pre-existing
group-media route without an assertion result. It is not a pass and its cause
is not proven. Added progress reporting on timeout; isolated group/reconnect
rerun passed in `-browser-sidebar-targeted.log`, including real sidebar media and
offline-unsubscribe cases. Final full-suite rerun is recorded below separately.

Final checkpoint gates (after sidebar/queue changes):

- **325 frontend tests passed**, 12 existing skips, zero failures, 1,052
  assertions across 49 files; `/tmp/wabi-group-reconnect-unit-release.log`.
- **All six headful media routes passed** in
  `/tmp/wabi-group-reconnect-media-release.log`. This supersedes the timed-out
  run above, whose cause remains unproven. The isolated rerun also passed.
- **All four broader headful suites passed**, sequentially without builds:
  `/tmp/wabi-group-reconnect-{group-membership,channel-access,call-state,lore-connect}-browser-release.log`.
  Group UI additionally verifies actual SocketManager hook ordering and a real
  IndexedDB legacy voice leave becoming non-retryable without emitting.
- **Typecheck: zero errors**, 181 existing warnings in 49 files;
  `/tmp/wabi-group-reconnect-check-release.log`.
- **Tauri frontend build and static build passed**:
  `/tmp/wabi-group-reconnect-tauri-release.log` and
  `/tmp/wabi-group-reconnect-static-release.log`. Static output was built last.
  These are not a native Linux installer or native WebView runtime verification.
- The 429-pass addons server checkpoint remains current: no server edits after
  that run. WabiDB source unchanged this continuation; final combined goal gate
  still requires the engine/replay rerun. Relevant skill validation and
  `git diff --check` passed. All commands for this checkpoint have exited.

Next pass must finish the remaining ownership-path review before release:
`handleForcedVoiceMove` retunes media but does not yet transfer the newly added
`voiceSocketOwners` mapping to the destination, so that destination needs a
reconnect regression and ownership update. Also verify denial/forced-leave and
ended-capture recovery boundaries rather than extending the happy-path claims.
Then finish the persistent archive boundary. Recon confirms `storage.ts` is the
normal `$lib/storage` entry (scoped by server), while `storage/index.ts` exports
a separate ChatStorage implementation; resolve actual callers before changing
both. Tauri migration also reads `chatStorage.loadAllMessages`. No cache/schema
edits were made in this reconnect checkpoint. No push, deploy or remote changes;
the original goal remains active, not complete or blocked.

## Forced voice ownership and ended-capture checkpoint (2026-09-08)

The preceding reconnect follow-up is implemented. The old server-move handler
waited for a source HTTP leave, had a separate SFU/relay-only setup, lost the
destination socket mapping, and could show a moved success after relay failure.
Forced kick also bypassed full scoped peer/screen/capture teardown. These are
client code findings; this checkpoint does not imply the moderator/breakout
server's multi-device move behavior has been integration-tested.

- Moves now retire source media synchronously, transfer primary/listener intent,
  focus/volume/mute and socket ownership, and reuse cancellable voice readmission.
  Intermediate ACKs and old initial-join catches cannot resurrect or erase a
  replacement. SocketManager lazy move/kick imports recheck their connection.
- Kicks use scoped leave, including P2P peers and screen shares. Other group or
  voice consumers survive; the final consumer releases the shared microphone and
  cancels a pending permission result. Recovery replaces ended capture only after
  admission. The transient-disconnect no-HTTP-leave rule is retained.
- Per-session transport labels now use that operation's fallback result instead
  of rereading the global diagnostic, which concurrent connections can overwrite.
- Added `/__voice_ownership` to the headful media runner. Real production call
  owners, encoders, capture graph, RTCPeerConnections and canvas screen streams
  run against fixture HTTP/Socket.IO/raw WebSocket. Assertions cover held source
  HTTP leave, chained moves, late ACK, reconnect after move, stale-socket kick,
  admission denial, group preservation, final microphone release, ended-capture
  recovery, kick during permission, move during initial permission, and scoped
  P2P/screen teardown. Empty P2P destinations do not claim connected media.

Verified so far (all listed processes exited):

- Initial and expanded targeted harness passed:
  `/tmp/wabi-group-voice-ownership-browser.log`,
  `/tmp/wabi-group-voice-ownership-expanded.log`.
- All **seven headful media routes passed** after the final source edits:
  `/tmp/wabi-group-voice-ownership-media-full.log`.
- **325 frontend unit tests passed**, 12 existing skips, zero failures:
  `/tmp/wabi-group-voice-ownership-unit.log`.
- **Typecheck: zero errors**, the same 181 warnings in 49 files:
  `/tmp/wabi-group-voice-ownership-check.log`.
- `git diff --check` passed. Tauri/static build results follow when complete.

This is not a native Tauri build/runtime, physical-device call, NAT/TURN or LiveKit
runtime certification. Persistent participant REST remains account-level; an
explicit same-incarnation leave/rejoin or rapid A→B→A can still race its delayed
HTTP leave. No new postcard/event/projection/server changes in this checkpoint;
the previous 429-pass addons server and 901-pass WabiDB checkpoints are not newly
rerun results. Remaining goal work is the managed archive privacy boundary and
combined replay/security/diff/upstream release review. Push and deployment are
authorized, but neither has occurred for this lane yet.

Final diff review additionally found stale socket ownership after an initial
voice-join failure. Cleanup now retires it, and a regression proves a later move
event cannot start an unrequested call. A real unanswered-P2P regression then
**failed before the fix**: after the 15-second connection timeout the visible
session was removed, but its RTCPeerConnection remained open. Reproduction:
`/tmp/wabi-group-voice-ownership-unanswered-before.log` (exit 1, specific failed
peer-retirement assertion; not a rendering or fixture failure). Replaced that
manual partial rollback with scoped `leaveVoiceChannel`; it retires peers/screens/
relay/socket ownership and preserves other capture consumers. Initial listener
cancellation sends unsubscribe, not an unrelated primary leave. Final verification
results below supersede earlier builds/tests when complete.

Archive reconnaissance (no archive edits yet): normal `storage.ts` fixes its
database to one server at module construction, not the account. Its load/export
and delayed archive flush paths lack membership/realm leases. Source search found
no active message-ingestion caller of `chatStorage.saveMessage`; do not claim this
legacy cache is the current incoming-message pipeline. It remains reachable by
StorageSettings export/statistics and Tauri migration, and shares settings with
Planner. The alternate `storage/index.ts` creates a separate ChatStorage. The
layout still schedules Tauri migration/autosave, but neither native entry point
registers `save_wabi_data` or `load_wabi_data`; do not invent a working native
sidecar backend or extend obsolete boot paths as if they persisted messages.
The next cache pass must preserve user archives/settings, quarantine data with
unprovable account ownership, trace actual callers, and protect managed reads/
writes across revoke/re-add and account/server changes. Already exported files
cannot be recalled. Native commands and archive operations were inspected only.

Read-only SSH to Tim succeeded (`hostname` → `tim-Predator-G3-572`). No remote
service, package, data or configuration changes were made.

Final voice-ownership checkpoint (all verification processes exited):

- All **seven headful media routes passed** with the final source and typed
  fixtures: `/tmp/wabi-group-voice-ownership-media-release.log`. The earlier
  `-media-verified.log` also passed the unanswered-peer regression after the fix.
- **325 frontend tests passed**, 12 existing skips, 1,052 assertions, zero failures:
  `/tmp/wabi-group-voice-ownership-unit-verified.log`.
- **Typecheck zero errors**, 181 existing warnings in 49 files:
  `/tmp/wabi-group-voice-ownership-check-clean.log`. The preceding
  `-check-verified.log` failed because the new fixture roster omitted three
  required boolean fields; corrected fixture, not suppressed types.
- **Tauri frontend and static builds passed**:
  `/tmp/wabi-group-voice-ownership-tauri-verified.log` and
  `/tmp/wabi-group-voice-ownership-static-verified.log`. Static output built last.
  No native installer or native WebView run is claimed.
- All four broader headful suites passed earlier in this checkpoint (before the
  final failed-join teardown consolidation):
  `/tmp/wabi-group-voice-ownership-{group,channel,call-state,lore}-browser.log`.
  The full media suite above was rerun after that consolidation.
- Relevant skill validation and `git diff --check` passed. No server/WabiDB source
  edits in this checkpoint; combined engine/server release gates remain pending.

Read-only remote check found `main` advanced to
`d63c897a1a3aa699011718d76e4a1edc7af52956`, while local HEAD remains `a362c75e`.
Inspect the incoming commits and overlaps before integration or more archive
implementation. Do not overwrite/stash-drop the security lane or the four
unrelated UI reconnaissance/polish notes. No push/deploy/commit/staging yet.

Fetched and inspected incoming `main` (no checkout/merge): three commits above
local HEAD, `d49ef9f3`, `6bbac333`, `d63c897a`. They change second-click voice
navigation to a session-targeted embedded panel without changing transmit focus,
mount CallModal for channel calls, add roster screen/camera badges and clearer
"Speak here"/"Listening" copy, and close Voice dashboard on channel navigation.
They also contain their own log rotation; do not rewrite unrelated upstream data.
Six incoming code paths overlap this dirty lane: `calling.ts`,
`callingStateStores.ts`, `calling_impl_core.ts`, `CallModal.svelte`,
`ChannelSidebar.svelte`, `VoiceView.svelte`. Preserve the newer view contract when integrating,
while retaining owned admission, awaited sidebar subscribe/unsubscribe, per-session
video selection and revocation. Incoming VoiceChannelList reads flattened global
video streams for badges; reconcile it with the session-indexed video model rather
than reviving cross-channel display ambiguity. Incoming `voiceView.ts` imports
`currentChannel` through the socket barrel; review for the already-reproduced
import-cycle class before merging. Current checkpoint tests/builds certify the
local security tree, not an integrated upstream tree. Integration and verification
are next, then the archive boundary and final combined release gates.

## Upstream call-panel integration checkpoint (2026-09-08)

Local main is now fast-forwarded to `d63c897a`, matching the fetched origin/main.
Before integrating, saved all security-lane work (excluding the four unrelated
UI notes) in the retained stash
`codex-group-security-before-main-d63c897a-20260908`, commit
`17476d3ebc59420cf893c20c0d4a5e05c0c60eb4`. Restored it after fast-forward;
the only conflict was ChannelSidebar. Content hashes confirmed preservation of
all 159 original files, with changes only in the six expected upstream-overlap
paths. The index was returned to its initially empty state. No stash was dropped,
no user note staged, no custom log/data change made, and no push/deploy occurred.

Preserved the newer embedded panel and second-click view-without-transmit-focus
contract, clearer call labels, dashboard navigation and badge artwork. Reconciled
the sidebar with awaited owned admission/listener APIs, scoped session video and
revocation. Actual production-panel testing found and fixed:

- Hang up targeted the global foreground call instead of the displayed background
  voice call. Scoped leave now also cancels offline voice/group recovery intent.
  Closing the channel panel docks the actual surface without leaving calls.
- Clicking the displayed fallback after its old explicit target ended did not
  fold the panel. Toggle now uses the displayed live fallback for that comparison.
- The same member's screen/camera badges leaked across channels through a global
  feed union. `voiceMediaRoster.ts` builds per-channel badge sets; the component
  derives them from live session-indexed feeds, retaining upstream art and labels.

Valid before-fix badge proof is
`/tmp/wabi-group-main-panel-badge-before-corrected.log`: original upstream
VoiceChannelList with correct DOM selectors showed both camera and screen in
both channels. Earlier badge failures used an incorrect descendant selector;
those are fixture errors, not valid product-failure evidence. Before-fix panel
Hang up/fallback failures are in `/tmp/wabi-group-main-panel-before.log`.
An intermediate nonexistent barrel export caused a harness module-load failure;
the direct core import fixes it. The full unit run then exposed cross-test mock
contamination; the badge builder is now import-light/pure, with store composition
in the component. The fixture's empty followed-channel set now has its required
`Set<string>` type. No suppressions or rendering workarounds were added.

Verification so far (listed processes exited):

- All **eight headful media routes passed**:
  `/tmp/wabi-group-main-media-integrated.log`, including foreground group revoke/
  re-add while viewing voice, and offline voice then group Hang up releasing the
  final capture consumer. Real generated media/production owners, fixture network.
- Final panel rerun passed after pure-helper/type corrections:
  `/tmp/wabi-group-main-panel-release.log`.
- All four broader headful suites passed on the integrated tree:
  `/tmp/wabi-group-main-{group,channel,call-state,lore}-browser.log`.
- **328 frontend unit tests passed**, 12 existing skips, 1,062 assertions:
  `/tmp/wabi-group-main-unit-verified.log`.
- Typecheck and Tauri/static frontend build results follow when complete.

Bounded interface review used the interface skill in full mode for the integrated
call panel/roster only, Svelte with existing plain CSS/tokens, not whole-app polish.

| Category | Evidence inspected | Result |
| --- | --- | --- |
| Typography | Existing call/badge labels in panel and roster | Retained; no typography redesign |
| Surfaces | Production panel view/close/Hang up with background sessions | Ownership defects corrected |
| Animations | No motion edits | 10%-speed playback not reviewed |
| Icons | Existing outline/currentColor camera/screen badges | Artwork retained; visibility corrected |
| Performance | Scoped badge derived-store updates | No performance profiling claimed |

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| HIGH | `frontend/src/lib/components/CallModal.svelte`, `callSurfaces.ts` | Viewed-call Hang up can leave another call; offline intent remains | Leave displayed live session; cancel its offline intent | A control must act on the surface it represents |
| HIGH | `frontend/src/lib/components/sidebar/VoiceChannelList.svelte` | Cross-channel media badge union | Channel-indexed badges and live removal | Static cues must report the actual channel's media |
| MEDIUM | `frontend/src/lib/calling_impl_core.ts` | Ended target prevents toggle-close of displayed fallback | Compare with live fallback | Routine toggle must be predictable |

Rejected: changing transmit focus on a view click contradicts the newer product
contract; new badge assets/styling would duplicate the existing design system;
wholesale legacy CallModal migration is not justified by these scoped failures.
Verdict: approve these corrected interactions on the headful fixtures, **not** a
whole-app/native/mobile/motion/performance certification. No native installer,
physical devices, NAT/TURN or LiveKit runtime verified in this checkpoint.

The managed archive boundary remains open. Source confirms no current inbound
message caller of either legacy ChatStorage.saveMessage implementation. Exports/
statistics remain reachable and do not prove owner identity. Do not add a new
offline history pipeline merely to satisfy the obsolete archive plan. Decide
between safely owned managed storage and retirement of unsupported access after
finishing the actual caller trace; preserve unowned databases and user files.

Final integrated call-panel gates: typecheck **zero errors**, 181 existing
warnings in 49 files (`/tmp/wabi-group-main-check-verified.log`); **Tauri frontend
and static builds passed** (`/tmp/wabi-group-main-tauri-verified.log`,
`/tmp/wabi-group-main-static-verified.log`), static built last. All processes
exited. Architecture skill validation and `git diff --check` passed. These build
results precede subsequent archive implementation and are not a final release
certification. Server/WabiDB unchanged in this integration checkpoint.

## Legacy archive privacy boundary (2026-09-08)

Replaced the earlier plan to extend/purge the old managed archive cache after
tracing every actual caller. No current incoming-message path called either
ChatStorage.saveMessage implementation. Yet StorageSettings still exported the
unowned records, and layout scheduled migration/autosave through native commands
absent from **both** src-tauri entry points. Extending this into a new chat-history
pipeline would be a different objective, not completing group revocation.

**Failure established:** a new isolated headful test seeds real IndexedDB legacy
and server-scoped archives, revokes the group in the production membership store,
mounts the real StorageSettings, and clicks its actual Export All button. The
old implementation exports `UNOWNED-PRIVATE-ARCHIVE` despite removal.
`/tmp/wabi-group-storage-before-synchronous.log` exits 1 at the content assertion.
Earlier probes are not proof: fixture API routing intercepted a Tauri module,
initial UI selectors raced mount, and a Promise-valued export polling condition
did not wait for completed Blob text. Corrected network-path filtering and
synchronous completed-export polling; no application rendering bypass.

Implemented retirement/quarantine:

- Removed both unused archive implementations, delayed cache/message helpers,
  archive settings helper, and unsupported Tauri migration/storage wrappers.
  Removed their layout timers/imports and obsolete server/local-clear calls.
  These are tracked code deletions recoverable from Git, **not data deletion**.
- Legacy `wabi-chat-db` and `wabi-chat-db:<encoded-server>` message records remain
  untouched and unassigned to the current account. The app never reads, exports,
  migrates, trims or automatically deletes them. No destructive purge or secure
  erasure claimed. Existing downloaded/exported files are unaffected. Explicit
  future recovery must establish ownership; preserve the original browser profile.
- `LocalSettings` preserves existing server-scoped Planner preferences through
  settings-only DB transactions; the directory barrel shares its singleton.
  It resolves the server per operation and rejects stale reads across switches.
  Write acknowledgment is transaction completion, including rejection when an
  otherwise successful request is followed by transaction abort. Unscoped legacy
  settings are also preserved in place, not silently assigned to a new realm.
  This does **not** establish per-account privacy for existing Planner preferences
  or implement its separate unsupported native business commands.
- Replaced StorageSettings with a Svelte 5 runes view explaining the unavailable
  archive/native backup, preserved old data and actual server retention. The
  active queue retains scope/retry controls, actual counts, loading/error/recovery
  states and a refresh action. It no longer displays a scaffold zero-byte usage
  estimate as a measurement. Corrected its existing translation namespace to
  `storage.offline`; added archive explanation keys in English and Spanish.
  Retry reports marking eligible actions, not successful sending.
- Local-clear copy now explicitly means the loaded in-memory view, not deletion
  of server history or unowned archive/user files. Server clear still updates
  its authoritative history and the live message store.

Verification so far (commands exited):

- `/tmp/wabi-group-storage-expanded.log` and `-themed.log`: browser and simulated
  Tauri modes passed; no message-store access or native commands, no export after
  account switch, legacy archive records unchanged, existing Planner settings
  round-trip, post-request transaction abort rejects, real queue retry leaves
  non-retryable failures failed, and queue read failure/recovery is visible.
- `/tmp/wabi-group-storage-unit.log`: **328 pass**, 12 existing skips, 1,062
  assertions. `/tmp/wabi-group-storage-check.log`: **zero errors**, 181 warnings
  in 49 files. These precede final fixture theme/polling refinements.
- The group suite's receipt check now polls the resolved IndexedDB status, not
  an async predicate's Promise truthiness. Its rerun passed in
  `/tmp/wabi-group-storage-group-browser.log`; other full-suite results follow.
- Screenshots `/tmp/wabi-group-storage-{desktop,mobile}.png` use actual default
  theme/CSS. The 390px image was inspected: readable status/copy and actions fit;
  it is not physical mobile/native validation. Initial unthemed fixture images
  were not accepted as the app's visual appearance.

Interface skill review: full mode limited to this Settings rewrite, existing
Svelte/plain CSS/tokens. Typography: verified translated labels and tabular counts;
surfaces: retained shared cards, wrapped scope/actions, 44px controls; animations:
none added, no 10%-speed motion review; icons: no new assets; performance: removed
obsolete bootstrap/cache timers, no profiling claim. HIGH finding was misleading
archive/autosave/retention claims and cross-account export; replaced with explicit
unavailability and quarantine. MEDIUM findings were raw translation keys and
fake zero-byte usage; corrected namespace and removed scaffold measurement.
Rejected automatic ownership migration (no provenance), new native backup backend
(not present and a different product objective), and new visual/theme system
(existing tokens suffice). This review does not certify other Settings surfaces.

Remaining goal work is now the combined engine/server/replay/diff/security gate
and authorized paired release. Do not reopen a nonexistent archive ingestion
pipeline as a hidden requirement. No push/deploy, native packaging, physical
Android, two-device audio, NAT/TURN or LiveKit verification in this checkpoint.

## Final combined release gates (2026-09-08)

The user explicitly authorized pushing and deploying this goal while asleep.
This supersedes the earlier read-only Tim/no-push restriction, not the controls
against overwriting live data, exposing secrets or removing an owned lock.

Final completed checks after upstream call-panel integration and archive retirement:

- `cargo test -p wabidb`: **901 tests and one doctest passed**;
  `/tmp/wabi-group-release-wabidb.log`.
- `cargo test -p wabi-server --features addons -- --test-threads=1`:
  **429 passing executions**, including the duplicated 173 lib/bin unit tests;
  one existing ignored mDNS doctest. `/tmp/wabi-group-release-server.log`.
- Frontend unit suite: **328 passed**, 12 existing skips, 1,062 assertions;
  `/tmp/wabi-group-storage-unit.log`.
- Final typecheck: **zero errors**, 181 existing warnings in 49 files;
  `/tmp/wabi-group-storage-check-release.log`.
- **Tauri frontend build passed, then static build passed last**;
  `/tmp/wabi-group-storage-{tauri,static}-release.log`. No native installer built.
- All eight headful media routes passed:
  `/tmp/wabi-group-storage-media-release.log`. Group membership, channel access,
  call state and Lore headful suites also passed:
  `/tmp/wabi-group-storage-{group,channel,call-state,lore}-browser.log`.
- Expanded themed storage browser/simulated-Tauri checks passed:
  `/tmp/wabi-group-storage-themed.log`.
- `git diff --check`, relevant frontend/offline skill validation passed;
  generated protocol and native Tauri trees remain unchanged.

The final media runner prepares all direct runtime dependencies before navigation
with Vite discovery disabled. A prior all-route run was invalidated by Vite's
late dependency optimization reloading the page mid-test (status running → ready),
not an application audio failure. Incomplete explicit prebundle lists then
exposed missing CommonJS default exports for opus-recorder and prismjs. The final
package-derived list passed every route without reload; no application minifier,
CSP relaxation or media behavior workaround was added.

Exact addon-enabled release artifact built successfully in
`/tmp/wabi-group-release-build.log`; SHA-256
`02b14de921290711044a20171d062ffd4b0fbcbee7df5207f3729e6dad1c1993`.
It contains three `Lore addon initialized` markers. Embedded static index hash:
`4d87a8a5676bf3a4ee57f46e353cc35b47d4ab7fbb9494956a171afeb0cc3ac9`.

Read-only Tim audit: existing healthy `wabi-server`, coturn, named tunnel and
Caddy; origin and public health pass from Tim, public root passes from Ronin.
Existing image and local host both use glibc 2.43. Lore is enabled live and must
remain enabled. Live binary hash is
`73510254fed1889c919d924165c66b78d5b01f7524a76887638080a07bef7788`.
The engine lock belongs to the running container; the top server lock is absent.
Tim's deployment directory is not a Git checkout. No remote source sync, key
rotation, live account probe, data mutation or lock removal in this audit.

Next release steps: packaged UI smoke, consistent stopped-server backup with
private credential/config capture, network-isolated candidate replay on a copy,
then commit/push and a recoverable exact-artifact swap if those checks succeed.
The deployment skills' older runtime-only Dockerfile, one-lock and live-register
recipes contradict current source/safety rules and are not followed.

Packaged runtime checks passed (`/tmp/wabi-group-artifact-smoke-authenticated.log`):
the exact release binary served its embedded static build, became ready, rejected
anonymous channel/admin requests, and rendered both first-run login and the full
authenticated lazy workspace in headful Chromium without page errors. The only
account created was in an isolated temporary Ronin database, not on Tim. Inspected
the authenticated screenshot; no real-device or native installer claim.

Consistent Tim backup completed while only `wabi-server` was stopped, then the
original binary was restarted and readiness verified. Private directory:
`/home/tim/Desktop/Wabi/release-group-20260908.5spRGE` (mode 0700). It contains
the original binary, data, uploads, plugins, compose and protected environment/
container configuration. The two lock paths were checked only after the owning
container had fully stopped; the remaining stale engine lock was moved into
`retired-locks`, not discarded. No conversation data was deleted.

Candidate ran against a separate writable copy in the **same runtime image**,
as UID 1000, with `--network none`, no published ports and no live writable mounts.
It became ready twice, preserved the existing owner marker, reported Lore enabled,
and served all **21 exact referenced embedded assets**. Runtime file logs show
no replay/postcard/corruption failure. `/tmp/wabi-group-preflight-verified.log`.
The test container is stopped and retained for inspection. Real-user login was
not attempted and is not implied by the owner-marker check.

An initial preflight assertion incorrectly compared composed production HTML to
the raw build index: Tim's branding rewrites its favicon/theme/title. Corrected
the verifier to compare the immutable asset graph and each asset's SHA-256.
Also captured actual `/app/logs` files: this runtime logs there, not to Docker
stdout. Neither observation required application source changes.

Rollback caution: old binaries do not implement the new group batch event.
After new group commands have been accepted, a binary-only rollback is not a
safe semantic rollback. Keep a second consistent cutover-time backup, preserve
any newer data before recovery, and never casually restore an old snapshot over
new accepted writes. Existing browser tabs must reload the paired client; older
bundled native clients are not upgraded by a server binary swap.

## Completed objective and live release (2026-09-08 Bangkok)

Implementation pushed to `origin/main` as
`0fdef72f53ff84b12b04dd2bfd4c0438641ca1e9`. It includes the earlier channel,
call-state and Lore security work on which this group lifecycle depends.
Upstream call-panel changes through `d63c897a` were integrated and verified.
The four unrelated UI planning/scouting documents remain untracked and unchanged.

Tim cutover started at **2026-09-07 21:54:03 UTC** (04:54:03 Bangkok); the new
container process started at **21:54:07 UTC**. A second consistent backup was
taken under `release-group-20260908.5spRGE/cutover` immediately before the swap.
The existing container/configuration was retained; only its bind-mounted binary
was replaced. No remote source sync, tunnel/coturn restart, package installation,
key rotation, user-account probe or conversation-data deletion occurred.
Old binary and retired stale locks are recoverable in that private directory.

Post-deploy evidence:

- Live `/proc/1/exe` and `/wabi-server` both hash to the exact tested artifact
  `02b14de921290711044a20171d062ffd4b0fbcbee7df5207f3729e6dad1c1993`.
- Tim's server is healthy; origin and public health pass from Tim. Ronin's public
  `/health`, `/livez`, `/readyz`, `/metrics` return 200. Anonymous channel and
  admin dead-letter requests return 401. Setup remains claimed; no real account
  credential was used or inferred from historical notes.
- Lore remains enabled. All 21 referenced public immutable assets match the
  candidate's SHA-256 manifest. Public HTML remains `no-cache`; branding is
  preserved. Public Engine.IO polling handshake succeeds.
- Headful Chromium loaded the actual public login with no page errors, including
  a 390px viewport capture. This is unauthenticated live smoke, not live-user
  login, a physical phone, native WebView, TURN or two-device calling proof.
- Captured runtime file logs since cutover: 80 lines, one ready banner, **zero
  ERROR/panic/engine-already-running entries** in the initial post-deploy sample.
- `/tmp/wabi-group-swap.log`, `/tmp/wabi-group-public-verified.log` retain command
  results. Backups are mode 0700; captured runtime environment is mode 0600.
  The network-isolated preflight container is stopped and retained, not running
  as a hidden second service. Local test/browser/build processes have exited.

This completes the scoped durable group membership/account-wide revocation goal:
commands, projection/replay, server admission/eviction, stale client/queue/media
ownership and the legacy managed archive boundary have implementation and
regression evidence, followed by the authorized paired deployment. It does **not**
certify all of Wabi as launch-ready. Native installer/physical Android/two-device
media remain manual verification work; existing browser tabs should reload and
older bundled Tauri apps require a matching client build for the new behavior.

Separate high-value next objective: message persistence failure currently can be
logged while a live/accepted event is still emitted (`socketio/messages.rs`).
That honest-acknowledgment invariant should be investigated and completed as its
own objective, not buried in or claimed fixed by this group release. Other known
limits (same-membership account-level call leave/rejoin races, generalized
multi-device P2P/direct-call reconnect, incomplete optional endpoints, independent
admin/session audit and historical secret exposure remediation) remain as stated
in the security model and earlier work records.
