# Room placement foundation — focused check

**Date:** 2026-09-28  
**Scope:** Main Wabi working tree; local disposable WabiDB data only.

## Change under check

- `WABI_NODE_ID` validates a bounded, operator-assigned Authority ID before the Authority binds its listener or opens storage. Existing single-server installs default to `node-1`.
- `room_placement_changed_v1` carries a channel ID, epoch, owner node ID and up to seven distinct recovery-replica IDs on `room-placement:v1:<channel-id>`.
- The `room_placements` projection rejects malformed IDs, duplicate/self replicas, a mismatched stream, and a repeated or skipped epoch. The first epoch is one.
- The sequencer isolates placement commands from neighboring group-commit windows and checks their payload, stream, creation order and next epoch against the fully applied projection **before** a placement command becomes durable. A rejected placement burns its candidate sequence but writes no commit-index entry. This is event validity, not room-write ownership admission.
- Selected durable chat, channel and group-membership commands now attach the owner and epoch observed by the adapter. The sequencer checks that condition after earlier placement changes have applied and before the room write becomes durable. A queued write admitted while a room was unplaced was rejected after an epoch-one placement committed. The adapter no longer mutates the channel projection before a delete command succeeds.
- New ordinary channels emit `room_placement_initialized_v1` in the **same commit** as `channel_created`. Its handler derives the existing `ch_<commit-sequence>` ID and requires that channel event to have applied first. New DMs/groups include their known-ID placement in their aggregate creation commit. Reopening a deleted DM advances the retained placement epoch.
- The Authority passes its configured node ID to `WdbAdapter`. When a placement already names a different owner, the adapter refuses tested message, reaction, clear and channel-metadata mutations before their WabiDB commit. REST and Socket.IO also check before Live-room session-only sends/edits/deletes; pin changes are checked before session mutation.
- Channel membership, moderation, webhook and retention writes now use the same owner/epoch precondition. Wiki, Forum, incident, gallery and project-task events whose durable stream is the channel ID also attach that precondition. The focused adapter check refused one create write for each of those five workspaces without advancing the commit position, then accepted local Wiki and task writes.
- Album create/delete and item add/delete resolve their parent room before committing. Whiteboard document writes resolve the `channel:` board prefix to that room. The focused check rejected these writes for a remote owner without advancing the commit position and accepted them for a local owner. Album access and parent-room resolution now use the derived `album_by_id` lookup. Engine startup rebuilds and saves this lookup from older snapshots before serving requests, without changing durable album record encoding or the applied watermark. This removes the per-request album scan; it is not a large-album capacity result.
- Channel-scoped attachment completion and whiteboard image/font publication now supply the room owner and epoch to the `upload_published_v1` command. The registry rejects channel-scoped publication without a matching precondition. A disposable check rejected an unguarded and a stale-owner upload without publishing the file or advancing the commit position, then published a local-owner file. Global profile/branding/emoji uploads remain unscoped. The explicit stopped-Authority legacy upload backfill retains its separate unfenced migration path.
- The five persisted call commands now require an owner/epoch condition. The adapter resolves join, leave, end and signaling through the stored session's parent. Sequencer preflight binds every new call event to that parent and the expected event stream, rejects missing/unrelated conditions and refuses a session ID rebound to another room. Call creation runs in its own group-commit window so the next queued create sees the first binding. The call JSON record shapes and historical replay handlers are unchanged. Missing-session adapter mutations return an error without fabricating a commit receipt; older absent teardown events still replay idempotently.
- Standalone direct calls retain their public/stored `dm:user-a:user-b` scope and use the distinct placement ID `call-dm-user-a-user-b`. API admission and WabiDB share the canonical pair parser, preserving lexicographic account order. First creation or recreation of an unplaced call appends epoch-one placement in the call's creation commit; sequencer preflight rejects a missing/mismatched initial placement and Channel collisions. A placed call keeps its epoch when recreated. This creates no DM chat Channel. The stopped backfill now includes retained active and ended direct-call scopes and validates them before selecting any batch.

## Commands and result

| Check | Result |
|---|---|
| `CARGO_INCREMENTAL=0 cargo test -p wabidb room_placement --lib` | 7 passed; the engine check committed a placement, removed any projection snapshot and reopened the database so the record had to replay from durable events. Initialization without its channel creation and placement records with an invalid record kind are rejected. A second check queued a duplicate epoch and a stale room write behind a valid placement, observed rejection of both before durability, then accepted epoch two. |
| `CARGO_INCREMENTAL=0 cargo test -p wabidb --lib sequencer::tests` | 13 passed, including group commit, durability, application acknowledgment and local writer-fence behavior after the owner/epoch admission check was added. |
| `CARGO_INCREMENTAL=0 cargo test -p wabi-server --lib advanced_node_ids` | 1 passed. |
| `CARGO_INCREMENTAL=0 cargo check -p wabi-server --bin wabi-server` | Passed; warnings in unrelated code remain. |
| `CARGO_INCREMENTAL=0 cargo test -p wabi-server --test room_placement_admission` | 3 passed after the channel membership/moderation/retention, five channel-stream workspaces, album and whiteboard document checks were added. New ordinary/private rooms received a local epoch-one placement; a reopened DM advanced to epoch two. One test rejected selected chat/channel/workspace writes without advancing the commit position or hiding a channel, then replayed placements after restart with the projection snapshot removed. Another returned HTTP 409 for a Live-room send and left the session cache untouched. |
| `CARGO_INCREMENTAL=0 cargo test -p wabi-server --test channel_lifecycle_contract` | 5 passed after placement was added to the channel creation commit. |
| `CARGO_INCREMENTAL=0 cargo test -p wabi-server --test group_membership_contract` | 6 passed after the group creation commit added placement alongside the existing channel and membership events. |
| `CARGO_INCREMENTAL=0 cargo test -p wabi-server --bin wabi-room-placement-backfill` | 1 passed. A disposable legacy room previewed as missing, received an epoch-one placement, remained idempotent on repeat, and replayed after reopen. A different node ID and an apply to a fenced Authority were refused. |
| `CARGO_INCREMENTAL=0 cargo check -p wabi-server --bins --tests` | Passed with warnings in unrelated code. |
| `CARGO_INCREMENTAL=0 cargo test -p wabi-server --test room_placement_admission --test channel_lifecycle_contract --test group_membership_contract --test message_retention_contract --test write_visibility_contract --bin wabi-room-placement-backfill` | Passed: 3 room-admission, 5 channel-lifecycle, 6 group-membership, 1 retention, 3 write-visibility and 1 migration check after sequencer owner/epoch admission was added. |
| `CARGO_INCREMENTAL=0 cargo check -p wabi-server --bin wabi-server` | Passed after the stale-owner response mapping was added. |
| `CARGO_INCREMENTAL=0 cargo test -p wabi-server --lib stale_room_owner_is_an_http_conflict` | 1 passed; a stale-owner sequencer rejection maps to HTTP 409. Socket.IO sends now report `room_not_local` for the same error; that specific socket race has code-level review, not a live interleaving check. |
| `CARGO_INCREMENTAL=0 cargo test -p wabi-server --test gallery_feedback_contract` | 4 passed after album owner admission was added. |
| `CARGO_INCREMENTAL=0 cargo test -p wabi-server --test channel_access_contract` | 39 passed with loopback sockets enabled. Two fixtures were updated to supply the current two-participant DM and Wiki edit-token request shapes. A sandbox-only run could not bind a socket and produced one unrelated fixture failure; the host-permitted run passed all cases. |
| `CARGO_INCREMENTAL=0 cargo test -p wabi-server --lib upload_registry` | 13 passed after guarded publication was added; this includes the existing registry persistence, recovery and stopped backfill cases. |
| `CARGO_INCREMENTAL=0 cargo check -p wabi-server --bins --tests` | Passed after all global upload fixture call sites supplied the new optional room precondition argument. |
| `CARGO_INCREMENTAL=0 cargo test -p wabi-server --test first_boot_onboarding` | 21 passed. The direct-router registration fixtures now supply the loopback client-address extension present on real HTTP connections; without it, six cases returned HTTP 500 before reaching their tested behavior. Upload recovery and revocation cases remained green. |
| `CARGO_INCREMENTAL=0 cargo test -p wabi-server --test regional_upload_cache_contract` | 1 passed with host loopback access. The sandboxed run could not bind a local socket. |
| `CARGO_INCREMENTAL=0 cargo test -p wabidb --lib projections::albums::tests` | 13 passed, including album ID lookup, deletion compaction and an older snapshot whose rebuilt lookup persisted on reopen. |
| `CARGO_INCREMENTAL=0 cargo test -p wabidb --lib open_backfills_album_id_index_from_legacy_snapshot` | 1 passed. After a durable album commit, the fixture removed only the derived lookup from the stopped snapshot; engine startup rebuilt and saved it while preserving the album and applied watermark. |
| `CARGO_INCREMENTAL=0 cargo test -p wabi-server --test room_placement_admission --test gallery_feedback_contract` | 3 room-admission and 4 gallery-feedback cases passed after the indexed album access and parent-room lookup replaced the per-request projection scan. |
| `CARGO_INCREMENTAL=0 cargo check -p wabi-server --bins --tests` | Passed after the album ID lookup, startup migration and projection registry metadata were added; unrelated warnings remain. |
| `CARGO_INCREMENTAL=0 cargo test -p wabidb --lib call_` | 27 passed after call parent/stream preflight was added. This includes all five command builders, malformed/missing/unrelated admission conditions, unchanged historical teardown behavior, applied call-state readback, and a queued same-ID create whose attempted parent change wrote no second commit and remained absent on event replay. |
| `CARGO_INCREMENTAL=0 cargo test -p wabidb --lib sequencer::tests` | 13 passed after call creation joined placement changes as an isolated sequencer window; normal group fsync, application acknowledgment, backpressure and local fence checks remain green. |
| `CARGO_INCREMENTAL=0 cargo test -p wabi-server --test room_placement_admission --test group_membership_contract --test write_visibility_contract --test channel_access_contract` | 52 passed with disposable loopback sockets: 4 room-admission, 6 group-membership, 3 write-visibility and 39 channel-access cases. All five call builders refused stale and unrelated room conditions without advancing the commit position; a raw unguarded end was also refused. Local calls worked after the placement returned locally. HTTP call create/leave/end/signal requests returned 409 for a remote owner, with unchanged stored state and no call push. Existing successful HTTP call publication, direct-call and membership/revocation behavior remained green. |

### Direct-call identity follow-up

| Check | Result |
|---|---|
| `CARGO_INCREMENTAL=0 cargo test -p wabidb --lib call_` | 30 passed. Canonical pair tests include lexicographic ordering, positive-i64 bounds and malformed aliases. New direct creation without its matching initial placement is refused. Two concurrent unplaced creates produced exactly one commit-index entry containing two event references; after removing the disposable projection snapshot, both the call and its epoch-one placement replayed. Recreation with the observed epoch kept that placement. Historical call replay fixtures remained green. |
| `CARGO_INCREMENTAL=0 cargo test --locked -p wabidb --lib sequencer::tests` | 13 passed; grouping, application acknowledgment, durability, backpressure and local writer fencing remain green. |
| `CARGO_INCREMENTAL=0 cargo test --locked -p wabi-server --test room_placement_admission --test group_membership_contract --test write_visibility_contract --test channel_access_contract --bin wabi-room-placement-backfill` | 58 passed with disposable loopback access: 6 room-admission, 6 group-membership, 3 write-visibility, 39 channel-access and 4 migration checks. API direct-call creation succeeded without a chat Channel and ignored the existing UI channel hint; outsider access was forbidden. Remote-owner join/leave/end/signal writes returned 409 without commits or pushes; an authorized duplicate create retained its no-op response. Recreated calls kept the owner epoch. An adapter test also refused a stale direct-call condition and a raw creation missing initialization, then replayed the stored scope and changed placement. Backfill covered active/ended legacy call snapshots, bounded repeatable batches, malformed/rebound scopes, corrupt keys and active/inactive Channel collisions. |

These are **101 focused local checks**, not a geographic capacity or failover
result. The first server build stopped on two migration compile errors (the
iteration callback returns `()`, and inactive Channels use `is_active`); both
were corrected before the successful rerun. No live community data was
migrated or deployed. Test data uses disposable directories retained until
the engine closes, and builds disabled incremental output.

### Message parent and lookup follow-up

The current worktree adds `message_by_id_v1`, a derived pointer index maintained
by message create/edit/delete and channel clear. The adapter resolves message
IDs without decoding unrelated history. Startup validates primary rows and
existing pointers before inserting missing pointers from old snapshots;
record bytes and the applied watermark are unchanged. Legacy duplicate IDs
remain room-scoped and fail ambiguous ID-only access. Compaction now removes
ID pointers and all time-index versions for a deleted message.

The sequencer binds six new local event types (message create/edit/delete,
channel clear, reaction add/remove) to the actual parent and expected stream.
A placed room rejects missing or unrelated owner conditions. Prepared creates
retain their parent within the fsync group; failed preparation does not admit
a later reaction. Same-ID room rebinding and mixed placement/message commands
are refused before durability. Blank legacy creation IDs use the same
sequence-derived fallback as historical replay. Historical replay is unchanged.

The first compile failed because the compaction predicate accepts `Fn`, not
`FnMut`; the local collection was corrected without changing that API. A new
test fixture used a nonexistent error variant and another used the wrong
placement stream kind; both were corrected. Three older missing-key tests
supplied plain text rather than a valid postcard message record. Their fixtures
now provide valid records and retain their missing-key assertions. These fixes
do not relax admission or replay behavior.

| Check | Result |
|---|---|
| `CARGO_INCREMENTAL=0 cargo test --locked -p wabidb --lib -- projections::message_lookup projections::room_writes projections::messages::tests engine::message_admission_tests sequencer::tests tests::send_message_flow tests::write_completion` | 80 passed: 5 ID-lookup, 4 parent-preflight, 34 message projection, 5 engine admission/migration, 13 sequencer, 5 missing-key/registration and 14 write-completion checks. Queued create/rebind/reaction produced only two commits and preserved the accepted room after full event replay. Missing stream-key preparation admitted no later reaction and wrote no commit. Missing/unrelated/wrong-owner conditions and mixed placement/message commands were refused with unchanged state/index position. A legacy snapshot rebuilt and persisted its missing pointer at the same watermark. Same-count wrong pointers and corrupt primary keys refused engine open without replacing the damaged snapshot or leaving its lock. |
| `CARGO_INCREMENTAL=0 cargo test --locked -p wabi-server --test room_placement_admission --test channel_access_contract --test group_membership_contract --test write_visibility_contract --test message_retention_contract --test message_delivery_contract --test message_parent_admission_contract` | 65 passed with disposable loopback sockets: 6 room-admission, 39 channel-access, 6 group-membership, 3 write-visibility, 1 retention, 8 delivery and 2 adapter-parent checks. Indexed lookup followed edits and a channel clear, then returned the same deleted record after full event replay. Missing-parent reactions produced neither commits nor projection changes. Existing call, private-room, permission and delivery checks remained green. |

The first server pass stopped on the direct-message delivery fixture's
encryption-pending send; an isolated backtrace located the missing acceptance
at that step. The fixture now first proves `e2ee_required` with no message in
history, then makes each participant's explicit server-readable choice through
the real member endpoint before testing plaintext delivery. A router-relative
URL correction and the new adapter fixture's `list_reactions` method correction
were made before the final green pass. No permission or encryption check was
weakened. These are **145 focused local checks**, not a distance, capacity or
failover result. Startup scan time/memory and sustained large-history load are
unmeasured. No live community data or installation was migrated/deployed;
incremental build output remained disabled and disposable test data closed
with its engines.

### Local engine identity follow-up

The engine now selects and validates its local node ID before filesystem
mutation, replay and sequencer startup. The sequencer retains that runtime
value and requires every provided room condition to name it before checking
the stored owner/epoch. A caller supplying a remote room's correct current
owner and epoch is refused here. Authority startup and stopped backfill use
identity-aware openers; the adapter reads the engine ID directly, and its
former builder can only assert that already-selected value. Default embedding
remains `node-1`. Server validation delegates to the engine's ID rules.

The existing custom-node fixtures now select their IDs at open rather than
after startup. The direct-call default-engine fixture uses the actual default
ID instead of an unrelated label. The message fixture keeps a genuinely valid
local condition for its unrelated-room and mixed-placement cases, so the new
identity check does not mask those older admission assertions. No durable
record format or historical replay rule was changed.

Authority state construction also checks identity before opening writable
sidecars. Its invalid-ID fixture requires that the configured data directory
does not exist after refusal. See the
[runtime identity operator contract](../deployment/NODE_RUNTIME_IDENTITY.md).

| Check | Result |
|---|---|
| `CARGO_INCREMENTAL=0 cargo test --locked -p wabidb --lib -- engine::node_identity_tests engine::message_admission_tests projections::room_placement call_ sequencer::tests tests::write_completion tests::integration` | 78 passed: 6 runtime-identity, 5 message-admission, 5 placement, 30 call, 13 sequencer, 14 write-completion and 5 integration checks. Invalid identity created no engine files. Correct remote owner/epoch conditions, including unplaced rooms and all five persisted call builders, were refused without commits or projection changes. Local conditions succeeded. Full event replay preserved remote placements without granting their write identity. The default opener remained `node-1`. |
| `CARGO_INCREMENTAL=0 cargo test --locked -p wabi-server --test room_placement_admission --test message_parent_admission_contract --test channel_access_contract --test group_membership_contract --test write_visibility_contract --test message_delivery_contract --test message_retention_contract --bin wabi-room-placement-backfill` | 72 passed with disposable loopback sockets: 7 room-admission, 4 adapter-parent/identity, 39 channel-access, 6 group-membership, 3 write-visibility, 8 delivery, 1 retention and 4 migration checks. Authority fixtures selected their configured identity before opening the engine. Invalid Authority identity created no sidecars or storage directory; invalid adapter identity created no root key. The compatibility builder accepted the current identity and refused renaming it. Existing parent, access, delivery, retention, visibility and stopped-migration checks remained green. |

These are **150 focused local checks**, not a geographic capacity or failover
result. No live community data, installation or firewall was changed. Builds
disabled incremental output. After the first server pass completed, the idle
6.7 GB incremental cache was removed while holding Cargo's exclusive build
lock; active build outputs were retained. Temporary test directories closed
with their engines. The final server pass includes the additional early
Authority validation and its no-filesystem-mutation regression case.

### Workspace parent follow-up

The database and adapter now share a catalog for all 22 saved event types in
Wiki/revisions, Forum, incidents, gallery/feedback and Project tasks/runs. New
local commands decode their full supported payload to find the parent channel;
the stream and any supplied owner condition must name that channel. Placed
rooms require a condition. Placement changes and workspace mutations cannot
share a command, and one invalid event refuses the entire command before
preparation. Unplaced legacy rooms retain single-Authority compatibility.

The Forum vote/solution decoders retain their existing postcard field order
and are shared with replay. This admission change does not alter durable
record shapes or replay rules. A concurrent Project implementation added
versioned task records and saved assistant runs while this check was running;
the admission catalog and fixtures now include its run event and both legacy
postcard/current task encodings. Its projection and history indexes are part
of the disposable state comparison. The initial server build observed a newly
declared module before its source file existed and failed compilation; the
existing build was allowed to finish before the combined-source rerun.

| Check | Result |
|---|---|
| `CARGO_INCREMENTAL=0 cargo test --locked -p wabidb --lib -- workspace_admission_tests workspace_writes projections::wiki::tests projections::forum::tests projections::incidents::tests projections::gallery::tests engine::node_identity_tests engine::message_admission_tests sequencer::tests tests::write_completion` | 114 passed on the combined worktree: 4 real-engine workspace, 4 workspace catalog/admission, 16 Wiki, 21 Forum, 14 incident, 17 gallery, 6 runtime-identity, 5 message-admission, 13 sequencer and 14 write-completion checks. Every covered event refused missing/unrelated/remote admission, disguised stream, invalid record/kind and malformed payload without commits or changed workspace state. Legacy/current task encodings were exercised. Local and unplaced-legacy writes produced 49 commits and identical state after removing the snapshot and replaying actual events. Queued stale and unguarded writes after an owner change were refused; a later current local condition succeeded. Mixed placement/workspace and two-room commands could not transfer a condition to another parent or partially commit. |
| `CARGO_INCREMENTAL=0 cargo test --locked -p wabi-server --test workspace_room_admission_contract --test room_placement_admission --test project_wiki_bot_contract --test gallery_feedback_contract --test message_parent_admission_contract --test write_visibility_contract` | 22 passed with disposable loopback access: 1 actual-adapter Forum/incident workflow, 7 room-admission, 3 Project/Wiki bot, 4 gallery-feedback, 4 message-parent/identity and 3 write-visibility checks. Actual Forum creation/reply/edit/vote/solution/metadata/deletion and incident creation/update/resolution passed with a local owner, refused remote mutations without changed state or commits, and reproduced the accepted state after full event replay. Existing permission, bot revocation, gallery, parent, call and visibility contracts remained green. |

See the [workspace admission contract](../deployment/WORKSPACE_ROOM_ADMISSION.md).
These are **136 focused local checks**, not a three-network, locality, capacity or failover
result. Complete admission for other internal/live paths, authenticated
enrollment, distributed leases, room routing and per-room recovery remain open.

## Boundary

New channel creation emits a local owner placement; normal message writes do not change it. Older rooms have no placement record until migrated and continue under the single Authority. The [backfill tool](../deployment/ROOM_PLACEMENT_BACKFILL.md) only assigns existing active rooms and retained direct-call scopes to the same local Authority at a stopped boundary; it has not been run on a live community. The sequencer preflights local placement commands and rechecks the observed owner and epoch for selected durable chat, channel, group-membership, album, whiteboard-document, channel-stream workspace and channel-scoped upload publication writes. The check is serialized with placement changes, but Live session-only work and other room workspaces/internal writers do not all carry this precondition. Upload staging and the JSON compatibility registry are sidecar writes before the sequenced publication; a late owner rejection can leave private staged bytes and metadata requiring safe cleanup. It is not a writer lease, signed placement map, room move, second room owner, selective delivery or failover result. A remote ownership change still needs a mixed-version gate, routing/admission and old-owner fencing before it can be made safe.

Persisted call state and signaling now participate in this sequencer admission,
including canonical standalone direct calls. Legacy unplaced direct calls can
continue under one Authority until stopped backfill or recreation initializes
their placement. This does not cover live media-room admission, peer signaling
or an SFU's ongoing streams. There is no direct-call owner routing, selective
delivery, handoff or recovery protocol yet. Pair-bearing placement IDs are
internal control data; this change adds no public placement/discovery API.
An observed owner condition is still application admission data, not a
distributed writer lease.
