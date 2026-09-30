# Wabi Project Status

**Updated:** 2026-09-30

**Purpose:** canonical product-status boundary for operators, contributors, reviewers, and AI agents.

Wabi moves quickly. Dated plans and old PR descriptions are useful history, but they are not automatically the current contract. When documentation disagrees about whether something is shipped, this page and the current source should win over older planning documents.

## Product boundary

Wabi is a **self-hosted communication and collaborative-workspace application for small communities**.

The intended model is:

- one community runs one canonical **Authority** server;
- the Authority owns that community's accounts, permissions, content, and durable state;
- one Wabi client may save and switch among multiple independent Authorities;
- those independent servers do **not** federate, share identities, or synchronize community state;
- optional helpers may improve media, ingress, private reachability, or other scoped functions without becoming additional state authorities.

Wabi is not trying to become a centralized hosted social network, a Matrix/ActivityPub-style federation protocol, or a distributed active-active database product.

## Shared Project Plan and bot wiki access — current worktree candidate, not deployed

The current worktree adds channel-scoped WabiDB Kanban cards to Planning/Lore Project views, with one permission-checked REST API for people and bot accounts. Card edits require a revision and record the latest editor; an owner can explicitly grant or revoke a bot's Project membership. Admission changes serialize with card/wiki writes, and mutations recheck membership before saving. The Project UI groups Board, Wiki and the channel's Discussion stream, with optional Lore Files for Lore channels. The broken Project/Chat toggle is gone. The existing device-local My Planner is separate and is not uploaded. Wiki page edits now require a current edit token so a stale save returns a conflict instead of silently replacing a newer page.

Three focused real-router/WabiDB tests pass for bot/wiki access and revocation, malformed card rejection, duplicate-operation conflict, a bot edit held behind the membership gate during removal, card create/edit/archive, stale edits, channel isolation, bot ping/history, and card replay after restart. The revoked bot edit is forbidden without changing the saved revision. A disposable loopback Authority test passed with two human accounts and an owner-admitted bot: the narrow bridge wrote a card and wiki page, both humans read them, a bot card update retained attribution, and a bot ping appeared in human message history. In a real browser, one human created a Project card, edited the bot's wiki page, and sent a Discussion message. A second human signed in, moved that card to Done and edited it; the first signed back in and saw the change, while an API read confirmed the second human's editor attribution. Settings Logout was repaired during this test. The browser also showed the redesigned board beside a pinned People panel, listed humans and the admitted bot in the assignee picker, kept the card editor above the panel, and rendered the board/editor at a narrow phone viewport. Hermes and OpenCode 1.18.32/2.0.18 each read the disposable board/wiki through a scoped bot bridge and created exactly one bot-attributed card using the free OpenRouter route; independent human/bot reads confirmed the results and the open browser refreshed to show the new cards. A disposable Iyoku Authority then passed remote human/bot edits, exact restart/reconnect reads and revoked-bot read/write denial. After correcting development-binary frontend packaging with the existing `field-embed` feature, a real browser on Ronin rendered Iyoku's shared Project board and read its bot-created wiki page. The focused tests pass with that feature enabled. Tim's live Authority was audited read-only and healthy. Those first-slice trials did not establish an automatic channel listener, durable worker or failover. The subsequent bounded Project Assistant candidate is described below. No Tim deployment or Pokee integration is claimed. See [the Project workspace contract](features/PROJECT_WORKSPACE.md), [dated acceptance evidence](testing/PROJECT_AI_WORKSPACE_ACCEPTANCE_2026-09-28.md) and [acceptance plan](plans/2026-09-27-ai-workspace-first-slice.md).

## Project Assistant and richer Kanban — current worktree candidate, not deployed

The candidate now adds a center-stage Assistant view to Project, with human-submitted reply-only or bounded card/wiki work, explicit provider handoff, durable run/checkpoint history and pause/cancel/resume/takeover controls. An optional provider-neutral worker polls one Project, receives no model-facing shell or credentials, and is fenced by run revision/attempt/lease at each tool. Only one run may be running in that Project. Interrupted pending edits require human review rather than automatic retry. This is a native Project conversation surface, not an installed ordinary-channel mention listener or encrypted-DM connector.

Cards now have notes, stable-ID checklists, links to independent cards, and human-only effort estimates. Bots cannot read, set or clear estimates; ordinary bot edits preserve them. A human estimate burndown uses recorded revision history and exposes scope changes/unestimated work. Humans and bots can claim unassigned unfinished cards with conflict checks; explicit reassignment remains available. In-progress cards identify who is working on them. Nine server contracts, four worker-runner tests and one burndown test pass. A real browser exercised human card creation/claim/estimate history, native Assistant requests/replies, pause/resume and takeover. An explicitly authorized disposable OpenRouter free-model trial created a card, then a fresh continuation claimed that card and created its wiki journal; reply-only also completed. Provider failures remained visible with no automatic retries. Independent human/bot reads and a local Authority restart confirmed card/wiki/run replay and protected estimates. Packaging passed with 0 frontend errors and existing warnings. Full evidence and provider limitations are recorded in [the dated acceptance](testing/PROJECT_ASSISTANT_ACCEPTANCE_2026-09-28.md). See [operator/worker contract](features/PROJECT_ASSISTANT.md) and [implementation plan](plans/2026-09-28-project-assistant-and-cards.md). This is a tested local candidate, not a Tim release or a generic coding-agent sandbox.

The September 30 candidate adds an optional, default-off AI Worker Connections addon with a Project-scoped computer roster and explicit manual/opt-in automatic recovery for bounded card/wiki runs. Registered workers use durable contact records, matched provider/model/harness, selected backups, a bounded recovery count and attempt fencing; uncertain pending edits block recovery. A real two-physical-computer trial interrupted the primary process, waited for actual expiry, resumed saved steps on the backup and rejected the returning primary with 409, leaving exactly one card. It used a deterministic provider stub, not a model or native harness. Eleven server contracts, eleven runner tests, four real engine admission/replay tests and old-run JSON compatibility pass; headful desktop/mobile UI acceptance passes. Native Codex chat, repository artifacts and uncommitted-code recovery remain unimplemented. No live deployment is claimed. See [Connections contract](features/PROJECT_CONNECTIONS.md) and [dated evidence](testing/PROJECT_WORKER_RECOVERY_2026-09-30.md).


## Moderation and newcomer candidate — current worktree, not deployed

The current worktree adds durable local account bans, per-channel bans and timeouts, server-side checks on authenticated HTTP/realtime paths, and case actions recorded with actor, target, reason and outcome. Operator IP deny entries use configured trusted-proxy address semantics; they remain weak shared-address restrictions. A report preserves only the explicitly selected message snapshot; the owner can remove it or set a lifetime for snapshots in new reports. Automated safety flags create cases without a content snapshot. Backups and staff comments have separate lifecycles. No global Wabi ban service or universal content log is involved. The Server Center and blacklist sidecars now reject damaged data at startup rather than treating corruption as empty policy. Existing WabiDB ban/mute events are not the enforcement path. See [operator recovery](deployment/MODERATION_POLICY_RECOVERY.md).

Owner browser and desktop host setup can choose and edit starter text/voice channels. New Authorities use a server-level Reference Desk for arrival without creating a Reception channel; existing Reception channels remain valid and operators can still add one through channel creation. Server rules now have revisions, a readable member dialog, and optional acknowledgment before community messages, edits, reactions, several channel content routes, and upload publication. Reception guides members with room descriptions and operator-defined community roles. Registered members can select those roles themselves; the Authority persists the choices and gates linked rooms. Staff roles remain staff-assigned. Separate room switches personalize the client's sidebar and do not grant access; Reception also exposes the existing desktop server-rail preference. Admins can set a persisted minimum server role for ordinary channels; discovery, reads, joins, and live subscriptions use these gates. A time-bounded raid posture temporarily requires invitations for new accounts and pauses guest joins. Unsupported verified/email-verification admission is refused rather than presented as protection; an existing verified policy requires an admin to choose open, invite, or closed before new registration. These behaviors are unmerged and require disposable restart/browser acceptance before a release claim. Full participation-route coverage and robust ban-evasion defenses remain open. See [the implementation plan](plans/2026-09-27-moderation-and-arrival.md).

## Friends and direct message repair — deployed on Tim, pending phone acceptance

The `codex/friends-dm-release-20260925` branch adds server-local friend requests
and accepted friendships, plus direct message room, fanout and history repairs.
The friend relationship is a durable Authority record; it does not grant access
to a DM. The tested release binary and embedded static frontend were deployed
to Tim on 2026-09-25. A disposable two-account browser test covered desktop,
mobile viewport and embedded PWA queue/reconnect behavior; the public page,
health endpoint and realtime handshake passed after deployment. Physical phone
acceptance remains pending, and this branch has not been merged into `main`.
See [the rebuild contract](plans/2026-09-25-friends-and-dm-rebuild.md).

The 2026-09-25 follow-up (`7cfed649`) is also live on Tim. It makes People
menus, profile and friend actions usable by mouse and touch, fixes mobile
navigation into a full direct message view, and adds a center-stage group chat
with creation, membership controls and older-history loading. Timed retention
changes now affect only messages sent afterward; the five-second policy sweeps
quickly without deleting earlier history, and the message timer and room badge
have been refreshed. The follow-up passed disposable two-account browser and
installed-PWA flows, group and retention regressions, and public health/page/
realtime checks. Physical-phone acceptance is still pending. Live mode can
temporarily hide older durable history while selected, and messages deleted
before this repair cannot be recovered.

The 2026-09-26 follow-up (`88db86a7`) is live on Tim. It fixes the realtime
startup race and installed-PWA delivery through HTTP polling, makes Friends
requests and notices visible, keeps DM previews current, and refines the
DM/group layout and per-message timer badge. A disposable two-account browser
run covered phone-sized installed PWAs, offline replay, friends, group and DM
messages, and 30-second to 24-hour to 5-second retention changes. The exact
release passed a fresh embedded-build smoke check; Tim's public page,
health/readiness and Socket.IO polling probes passed after the swap. Physical
phone acceptance remains open.

### Experimental conversation encryption — deployed on Tim

The Tim release branch adds an experimental default for newly created DMs and
groups. Each new room starts encryption-pending. Registered participants'
clients create device keys, and the room can switch to encrypted text only
after every participant has a registered device. The Authority rejects
plaintext sends while encryption is pending. A participant can explicitly
choose server-readable chat instead; that choice stops automatic enablement,
and **each sender** must confirm server-readable mode before sending plaintext.
The original rollout left earlier rooms in their previous mode. Damaged
encryption-registry state blocks sends and key changes
instead of silently resetting. The cosmetic “Sealed / Private / Open” menu no
longer appears as a security control. This rollout remains under acceptance
testing, including physical phones, and is **not an independently verified
E2EE or operator-blind guarantee**. See [the privacy stance](PRIVACY_STANCE.md)
for the trust boundary.

The 2026-09-26 follow-up (`e2639368`) is live on Tim. It registers signed-in
browser devices and upgrades **future messages** in older readable rooms to
experimental encryption once every participant has a registered device, unless
an explicit server-readable choice is in force. Historical plaintext remains
server-readable. This branch is not merged; physical-phone acceptance and
independent E2EE verification remain open.

### Shared conversation notes — deployed on Tim, pending phone acceptance

`codex/dm-call-notes-followup-20260926` adds a collapsed-by-default Shared notes
panel for DMs and groups. Saved notes use a separate Authority-backed store,
membership checks, author-only updates and revision checks, with live refresh
for recipients. Existing personal browser Notes remain private and are not
uploaded automatically. Readable rooms store readable notes; experimental
encrypted rooms store signed ciphertext envelopes and pending rooms reject
plaintext. Shared notes outlive message timers until removed or the room is
deleted, and Authority data-directory backups include them. The 2026-09-26
follow-up is live on Tim but not merged. See [Local Notes](features/LOCAL_NOTES.md)
for the detailed storage and backup boundary.

The exact release binary SHA-256 is
`57452407550d192214e6d4362325b84b689aea169a508f9e0e0ce0e2b87e565c`;
its embedded PWA build ID is `bc3da61ab7d3546f`. Tim was stopped for a full
data/uploads/config/binary backup at
`/home/tim/wabi-backups/authority-20260926-dm-call-notes-followup` before the
swap. Disposable two-account tests covered encrypted shared-note delivery and
reload, default-relay DM/group camera frames, and two controlled phone PWAs
exchanging durable messages, including HTTP polling and offline replay. Tim
origin and public readiness, application shell, protected note/admin routes,
realtime polling, and the Lore addon passed after restart. Physical devices
remain an acceptance gate.

## Activity center candidate — not deployed

The current working tree moves Friends out of Messages and adds a center-stage
Activity view. It combines friend requests from signed-in saved servers,
current-server unread conversations and loaded-channel mentions, plus a separate
Following view for locally followed channels across saved servers. The inactive
server follow poll reads bounded, authenticated channel history; it does not
federate Authorities. Notification settings now link to this behavior, including
a switch for inactive-server followed-channel system alerts. Message preview
text in followed snapshots is kept in memory rather than local storage.

This is not a durable all-server notification inbox. Unfollowed mentions and DM
unread state on inactive servers are not aggregated, and Web Push still supports
test delivery rather than normal message dispatch. Emergency priority alerts and
distinct sounds are not implemented. See the [notification contract and gaps](features/NOTIFICATIONS.md).

## Social polish wave candidate — not deployed

The working tree adds device-type hints in call/audio pickers, a reviewed batch-leave
flow for server-local group DMs, a bundled static name-style pack, and chat game
suggestions from the sender's explicitly server-shared Games board. Group cleanup
does not infer inactivity from an unloaded message cache; users select the groups
they intend to leave. Game insertion is readable text with a safe store link for
Steam entries, not a protocol-level notification or a claim that Wabi tracks
live game activity. Name presets have a plain rendering fallback. See the
[implementation plan](plans/2026-09-26-social-polish-wave.md).

## Profile creator and presentation candidate — not deployed

The working tree adds an editable name/plate studio with typography, gradients,
glow and slow shimmer, plus versioned design-file import/export. Names and plates
use shared rendering in messages, People and profile cards. Appearance offers
one plain-profile switch and separate names, plates, artwork and motion controls;
app/OS reduced motion keeps profile images still and stops name shimmer.

Profile saves now wait for an owner receipt, preserve existing layout/profile
values and broadcast saved updates to other viewers. Full profile dialogs work
for self and other members; complete profiles also open in the existing optional
right dock and expand back into the large card. Profile targets follow live
account data and clear on server/account/logout changes. The artist guide
specifies a recommended 1200 × 400
banner, 512 × 512 transparent decoration, image formats, upload limits, cropping
and downloadable artboard templates. Two example looks include a painted banner,
a four-second animated WebP/GIF banner, editable animation source and portable
name/plate designs. See the
[profile contract and showcase gaps](features/PROFILE_DESIGNS.md) and
[artist guide](features/PROFILE_ARTIST_GUIDE.md).

Server emoji catalog, upload conflict/error and reaction-identity fixes are also
in this candidate. Super reactions, emoji confetti, profile-wide effects/frame
authoring, verified connections and a design marketplace remain unimplemented.
Focused tests and a static frontend build pass; local browser checks use a mock
transport. A live two-account showcase, physical phones and native webviews
remain acceptance work. No deployment of this candidate is recorded.

## Service access candidate — not deployed

Admin Roles now includes separate custom service roles, inline service/member
pickers and protected built-in grants. The additive WabiDB model and explicitly
registered TCP gateway preserve account/admin/Tailcat boundaries. Native
printer/game/remote-support client setup is not automatic; see
[service access contracts and limits](features/SERVICE_ACCESS.md). A
[physical Tailcat port and service-role check](testing/TAILCAT_SERVICE_PORT_FIELD_2026-09-27.md)
connected to Ronin's RustDesk TCP listener with a device-limited pipe, then
separately carried HTTP bytes through Wabi's role-gated TCP gateway from
Ronin to iRonin. The native RustDesk client also reached its password prompt
through a temporary Tailcat TCP bridge; full screen control awaits RustDesk
authentication. The native app was not integrated with Wabi roles.

## Independent personal Planner — current worktree candidate, not deployed

The candidate adds `/personal` and a login-screen entry for Calendar, Board, Journal and Projects without community login. Browser personal records have a separate IndexedDB identity. Tauri personal records use an origin-checked private IPC operation in the bundled server sidecar, storing versioned local JSON snapshots without launching a listener, community Authority or provider. Revision conflicts preserve recovery drafts; existing account Planner data is not migrated automatically. Scoped Rust tests, real sidecar process readback/restore, frontend checks and a real browser personal flow were exercised. Native packaged WebView/installer and non-Linux acceptance remain open. Personal publication, AI access and device sync are not implemented. See [Local Planner](features/LOCAL_PLANNER.md) and [acceptance](testing/PERSONAL_PLANNER_ACCEPTANCE_2026-09-28.md).

## Desktop hosting candidate — not a released installer claim

The current working-tree candidate brings the previously unmerged Desktop Host
Mode work into the desktop app, with local owner setup, saved community
identity/location, an owned Authority process, explicit LAN sharing, single-use
invitations and stopped backups. Normal desktop packaging now stages the
Authority alongside the client; mobile remains client-only. See the
[hosting guide](deployment/SELF-HOST-GUIDE.md) and
[implementation and validation record](deployment/DESKTOP_HOSTING.md).

Host now offers Simple or Configurable setup. Simple ends at a ready community
with an invitation action, discovers active private IPv4 addresses after LAN
opt-in, and asks the user to choose when several networks are present. It does
not infer internet reachability. Tailcat first-time invitation enrollment is
still separate unfinished integration work; existing member transport is not
an automatic remote join flow.

This does not certify existing downloads, clean-machine installation, upgrades,
Windows/macOS runtime behavior, remote reachability or physical-device calling.
The app does not automatically provision internet/private access or a system
service. A saved local community is started from Server status after reopening
the app. Server-readable content remains server-readable.

## Local field pilot candidate — not deployed or field validated

The working tree contains the invitation QR and an operator-enabled
(`WABI_FIELD_PILOT=1`) Authority field session API with a Maps workspace pilot
for manual check-ins on a shared schematic. These changes exist in the source
checkout; no package, release, or deployment of this pilot is recorded. An
existing installed Wabi will not show it. A build from this checkout needs the flag on
the Authority to show the field board. An owner/admin starts a time-bounded
session, invited registered members consent before reporting, and the leader
can acknowledge help or remove a participant. Reports and positions are kept
in a separate plaintext sidecar with a bounded expiry sweep; see
[backup and privacy limits](deployment/BACKUP_AND_RECOVERY.md#field-pilot-sessions)
and the [local trial plan](plans/2026-09-27-local-field-communications-trial.md).
Focused backend tests cover auth, consent, revocation, help acknowledgement,
expiry and corruption. Mixed-phone, hotspot, NFC and real outing acceptance
remain open. The pilot is voluntary manual reporting, not automatic tracking,
emergency response, radio transport or a safety certification.

## Network health and volunteer boosters candidate — not deployed

The working tree adds Admin network/process observations, the current helper
roster and media assignment counts, Tailcat pipe-port/device access controls,
and optional member file-cache boosters. Volunteers opt in per app session;
normal Authority downloads remain the fallback. Direct peer delivery and
interrupted/corrupt-peer fallback have passed both a loopback rehearsal and a
[three-machine browser field run](testing/BOOSTER_FIELD_TEST_2026-09-20.md).
The Janya–Tim peer path used public UDP; another tested pair fell back to origin.
Small-file peer startup was slower than origin delivery.
This is scoped attachment delivery, not generic distributed compute, media
capacity certification, mesh networking or HA. See [volunteer booster operations](deployment/VOLUNTEER_BOOSTERS.md)
and [candidate acceptance](testing/NETWORK_BOOSTERS_2026-09-20.md) for exact limits.

## Production-finish candidate — not yet merged or deployed

The current worktree develops a [Reference Desk arrival surface](plans/2026-09-27-onboarding-reference-desk-reader.md): the server identity opens an overview of rules, roles, room visibility and help with a separate choice editor. New accounts enter its welcome view; an Authority-side pending marker resumes interrupted introductions and clears when the member leaves welcome. New Authorities no longer create a required Reception channel. Existing Reception channels remain valid. Server Branding can publish a welcome message, help text/resource link, a suggested starting text room, structured text/link/role poster blocks, and a moving GIF/WebP desk background with a still image for reduced motion and pause, plus an optional focused first-visit view. The optional opening preference selects Reference Desk or Messages in center stage and is scoped to account/server on this device. Guest entry obtains a temporary Authority credential so the desk and rules load; guests cannot self-assign member roles. Imported Reader images now have content-derived identity and local pen/highlight/text/erase/undo/export controls. General forms, full invite-destination restoration, and media processing polish remain open. A disposable browser has exercised welcome, returning desk, role poster choice, and guest guide access; these worktree features are not yet a merged release.

`codex/production-finish-20260915` adds account/server-scoped local Notes with transactional saves, independent editor drafts, conflict recovery, trash, titled wiki-links/backlinks, explicit legacy recovery, JSON backup/import, portable Markdown archives, keyboard link completion, a reading view, explicit broken-link reconnect and a shared scratchpad. Reader storage upgrades preserve older writing, and a scoped return control links Reader copies to their source notes. Profile annotations now use scoped, revision-checked writes. See [Local Notes](features/LOCAL_NOTES.md) for storage boundaries, backup limits and unfinished acceptance work.

The current worktree redesigns local Projects around a searchable inventory and selected-project Overview, moving charts to optional Reports & sprints and retiring standalone Insights navigation. Overview includes descendant task counts; Journal opens a wider entry stream. Shared card links now offer searchable entity selections and context previews. Local Journal supports formatted/code content and image/text-file input. Names attached are explicitly metadata rather than publication. These changes do not add shared calendar/journal/project-tree state or automatic AI launch.

The candidate also scopes device-local Planner data to its server/account, retains competing or failed-save drafts, and replaces destructive imports with validated additive imports. Planner server sync is unavailable. Recurring calendar occurrences render with local-date handling and explicit whole-series editing. See [Local Planner](features/LOCAL_PLANNER.md).

This candidate also contains the production-finish entry-page, mobile-panel and authentication repairs tracked in the [campaign ledger](plans/2026-09-15-production-finish-campaign.md). Candidate checks do not promote the deployed website, full workspace suite, native devices, self-host installation, restore procedure or physical-device calling to production-ready status.

## Available in the current main product line

### Communication and community

- Text channels, direct messages, group conversations, replies, typing/presence, guest access, roles, and owner/admin controls.
- Voice, video, and screen sharing with the existing Wabi call stack and optional TURN/SFU deployment support.
- Multi-server client/server switching while keeping each server an independent trust boundary.
- Custom server branding and a substantial theme/customization system.
- **Optional Translator Assist:** per-user on-demand and viewport-aware automatic message translation through local or explicitly chosen self-hosted LibreTranslate. It is disabled by default, bundles no language models, and does not proxy translation plaintext through the Wabi Authority.

### Workspaces and creative review

- Shared whiteboards and wiki/content surfaces.
- Dockable center-stage workspaces for communication and non-chat tasks.
- Long-form Reader workspace with search, outline, bookmarks/notes, continuous/paged reading, focus mode, and supported text/image imports.
- CAD/model review:
  - DXF read-only 2D viewing and markup;
  - DWG through an optional operator-provided `dwg2dxf` helper;
  - 3MF import into the normal 3D viewer;
  - STEP/STP/IGES/IGS import through OpenCascade WASM into the normal 3D viewer;
  - Model Space / Paper Space layout handling and detection of spatial model content.
- Lore project workspace with file/history/review/local-folder workflows when the optional external Lore integration is available.

### Platform and deployment

- One Rust `wabi-server` core containing the API, realtime services, embedded static frontend, and WabiDB.
- WabiDB as the in-process durable state engine; no external SQL/STDB database is required for the normal Authority deployment.
- Docker/Podman single-machine deployment.
- Tauri desktop source/build path.
- Optional coturn, LiveKit, SRT media gateway, Cloudflare tunnel profiles, and other helper services.
- Optional Tailcat private-access transport for supported desktop clients.
- Plugin package integrity/signing/scanning/audit machinery and runtime loading framework, with plugin mode opt-in.
- Local visual effects and sprite-sheet emote support.

## Experimental or incomplete

These exist in source or active development but must not be advertised as completed production guarantees.

### Multi-node / availability

- **Workspace parent admission — current worktree:** the shared database/adapter catalog covers all 22 saved Wiki, Forum, incident, gallery and project-task/run event types. Before preparation, the sequencer decodes the existing payload and binds its actual parent to the stream and owner condition; placed rooms refuse missing or unrelated conditions. Placement and workspace mutations require separate commands, so queued writes observe applied ownership. Historical replay and durable record layouts are unchanged; unplaced legacy rooms retain single-Authority compatibility. See [operator contract](deployment/WORKSPACE_ROOM_ADMISSION.md). This does not complete other internal/live admission, distributed leases, independent room owners, routing or failover.

- **Engine writer identity — current worktree:** the Authority and stopped placement backfill now select their node ID before WabiDB opens. The engine retains an immutable runtime ID and supplies it to the sequencer; the adapter reads that value instead of maintaining a separately mutable copy. Every provided owner condition must match both this local ID and the placement owner/epoch, so a caller cannot claim a remote room's recorded identity to write here. Default embedding still uses `node-1`; custom embedding uses an identity-aware opener, and the old builder is only an assertion. No durable record layout or historical replay rule changes. See [operator contract](deployment/NODE_RUNTIME_IDENTITY.md). This is operator configuration, not authenticated node enrollment, a distributed lease, complete room-write admission, routing or failover.

- **Message parent admission — current worktree:** new durable create/edit/delete, channel clear and reaction events now bind their owner condition to the actual message parent and expected stream. Placed rooms refuse a missing or unrelated condition before durability; queued creates retain their accepted parent within ordinary group commits. Placement changes and these message writes require separate commands. ID-only adapter reads use the derived `message_by_id_v1` pointer index, rebuilt from older snapshots at startup without changing durable message encodings. Legacy duplicate IDs remain in their scoped rooms and fail ambiguous ID-only access. Startup validates all primary message rows and existing pointers, adding startup time and temporary memory proportional to history; large-community capacity remains unmeasured. See [evidence and boundaries](testing/ROOM_PLACEMENT_FOUNDATION_2026-09-28.md) and [operator guidance](deployment/MESSAGE_ID_LOOKUP.md). The separately described runtime identity check does not establish a distributed lease or finish live admission, regional routing or failover.

- **Room placement foundation:** `WABI_NODE_ID` now accepts a bounded operator-assigned Authority ID, defaulting to `node-1`. WabiDB stores versioned room owner/replica IDs and contiguous epochs. New ordinary channels and private conversations [commit an epoch-one local placement atomically with channel creation](testing/ROOM_PLACEMENT_FOUNDATION_2026-09-28.md); reopening a deleted DM increments its retained epoch. The sequencer checks local placement commands before durability and isolates them from adjacent group-commit windows; a queued duplicate epoch was refused without a durable entry. A [stopped-Authority backfill](deployment/ROOM_PLACEMENT_BACKFILL.md) can assign legacy active rooms and retained direct-call scopes to the same local node in bounded batches. Focused checks covered malformed/duplicate IDs, stream and epoch rejection, replay recovery, backfill preview/apply/reopen, and refusal of tested chat/channel mutations when the recorded owner differs from the local node. A Live-room REST send returned 409 without entering the session cache, and a stale-owner sequencer rejection maps to HTTP 409. Selected durable chat, channel, group-membership, Wiki, Forum, incident, gallery, project-task, album, whiteboard-document, persisted call-state and channel-scoped upload publication writes now recheck their observed owner and epoch at the sequencer boundary; a queued stale write is refused before durability. Call events additionally require the actual stored session parent and expected stream; isolated call creation refuses a queued same-ID parent change before durability, and a disposable event-replay check preserved the accepted parent. Standalone direct calls now use a separate canonical placement ID, commit initial placement with call creation, and join the stopped migration for retained active/ended sessions; their stored/public scope and DM chat identity stay unchanged. Live media admission is outside this result. Live session-only work and other internal writers still lack complete atomic admission, and there is no route to a second owner. Upload staging/JSON metadata may remain after a late owner rejection. Album access and parent-room lookup now use a derived ID index, rebuilt and saved from older snapshots at startup without changing durable album records; no large-album capacity result is established. Gate D and per-room failover remain open.
- **Regional cache policy follow-up:** an Anchor now requires the Authority's current HEAD response to allow revalidated caching before it serves a stored upload. If the policy is absent or contains `no-store`, the Anchor evicts its copy and forwards the GET; a client's `no-store` request also bypasses caching. [Seventeen focused Anchor checks](testing/REGIONAL_UPLOAD_CACHE_2026-09-27.md) passed with local listener permission, including a live policy change, and the real Authority/Anchor upload contract passed again. Upload URLs remain capability URLs without a per-member file ACL; this is a cache-control boundary, not a privacy certification or a three-network capacity result.
- **Trusted helper-node registry:** operator pairing fixes a helper's granted capabilities; its heartbeat can no longer claim `Standby`, `Backup` or another ungranted role. The Authority now rejects a damaged/unreadable `node_registry.json` at startup, saves it by private atomic replacement on Unix, and does not publish in-memory node changes when a save fails. [Ten focused registry checks and a server-binary check](testing/TRUSTED_HELPER_REGISTRY_2026-09-28.md) passed. This protects the helper trust boundary and does not create voting nodes, a writer lease, a recoverable standby or automatic failover. See [network operations](NETWORKING.md#trusted-helper-pairing).
- **Regional Anchor role:** the current working tree streams HTTP and forwards WebSocket upgrades. A [three-process loopback preflight](testing/THREE_SITE_ACCESS_PREFLIGHT_2026-09-27.md) checked two Anchors reaching one Authority, independent Anchor loss, expected 503 after Authority loss, Engine.IO polling, Socket.IO WebSocket connection and close-code/reason forwarding in both directions. A separate [real Authority plus two-Anchor disposable run](testing/THREE_SITE_REAL_AUTHORITY_PREFLIGHT_2026-09-27.md) passed two-site sign-in, polling and WebSocket, bidirectional cross-Anchor live and durable messages, resumable upload, cache miss/hit, a surviving write after one Anchor stops, and the expected API/cached-file 503 after Authority loss. A [three-computer Tailscale field check](testing/THREE_SITE_FIELD_2026-09-27.md) repeated the real-process flow; HTTP client probes running on Ronin and Iyoku read history and wrote messages visible at the other site. The operator confirmed iRonin later returned to Iyoku's network, so that metered follow-up had only two observed public egresses. After iRonin moved again, a [fresh three-site run](testing/THREE_SITE_FIELD_2026-09-28.md) observed three distinct uplinks and passed authenticated WebSocket sends from client processes on Ronin and Iyoku, with accepted/delivered IDs matching durable cross-site history. It repeated the scoped static/cache byte measurements. Full Gate A desktop/media acceptance remains open. An opt-in bounded RAM cache now serves eligible canonical uploads after a fresh Authority HEAD check and digest verification; a [real Authority-to-Anchor loopback check](testing/REGIONAL_UPLOAD_CACHE_2026-09-27.md) covered cache fill, hit and revocation. Upload HEAD and conditional GET recheck revocation; authenticated whiteboard files use `no-store`; and the service worker no longer keeps a stale offline copy of revocable uploads or whiteboard files. A disposable loopback meter first confirmed that a repeat cache hit avoids retransmitting the file, while still making an Authority HEAD request. Anchors also serve matching embedded versioned app assets locally; a [real three-process loopback check](testing/THREE_SITE_REAL_AUTHORITY_PREFLIGHT_2026-09-27.md) compared a 28,424-byte chunk byte-for-byte at both Anchors, with no Authority request for that asset, and a focused test forwarded missing versions upstream. The metered three-computer follow-up counted zero upstream bytes for that asset at both Anchors and 263,175 Authority-to-Anchor bytes for a 262,144-byte equipment cache miss versus 504 bytes for a hit. These are scoped TCP measurements; whole-interface and sustained bandwidth results remain open. The upload URL itself remains the access path, without a per-member file ACL. Public Anchor health no longer discloses the configured Authority URL. Infrastructure now probes the selected endpoint's local role separately from Authority-owned network measurements and helper heartbeats; the role probe has focused unit coverage and an Anchor CORS header assertion, but no physical desktop acceptance yet. Anchor requires HTTPS for public Authority upstreams, with an explicit private-IP HTTP opt-in for protected links. Same-desktop, long-lived session, media and full bandwidth acceptance remain open; Anchor still forwards canonical chat/API work to the Authority and does not make conversations local or provide failover. See [cache operations](deployment/REGIONAL_UPLOAD_CACHE.md).
- **Community entry-point candidate:** the working tree can publish an owner-approved signed list of Authority/Anchor URLs through a Server Center editor or API, derive a stable public community ID from the WabiDB root key, and pin the roster in the client. The owner editor requests a fresh password proof and verifies the published signature; it does not probe endpoint reachability. A legacy file roster is imported once; subsequent owner updates are ordered WabiDB events. A [disposable two-process check](testing/DB_REPLICA_PROCESS_2026-09-27.md) copied a later roster event to a fenced development receiver, and a local restart check preferred the database over a stale/damaged legacy file. Registered sessions can be carried only to exact listed HTTPS URLs. The old unsigned reconnect-candidate path no longer carries tokens. The desktop Tailcat path now probes and restores its temporary local proxy, but still requires sign-in at that address; it has no signed peer binding for token carry. This has focused code-level and local visual verification, not a three-network acceptance run. Plain HTTP private addresses require manual sign-in; local client state remains URL-scoped. The roster does not elect a writer, make a whole instance recoverable or make an Anchor available after Authority loss. See [entry-point operations](deployment/COMMUNITY_ENTRY_POINTS.md) and the [Tailcat switch check](testing/TAILCAT_ENTRY_SWITCH_2026-09-26.md).
- **Client reconnect order:** a focused [roster rotation check](testing/CLIENT_ENTRY_POINT_ROTATION_2026-09-27.md) found that retries could alternate between two sites while leaving another approved site untried. The working-tree client now keeps roster order and the check visits all three HTTPS sites, skips private HTTP credential carry, and aborts after a session or endpoint change. It is code-level evidence only; Ronin/Iyoku application reconnect, URL-scoped offline work, and live Authority loss remain unproven.
- **WabiDB network replication:** a [disposable fenced-engine check](testing/FENCED_REPLICATION_2026-09-27.md) validates, durably appends and applies pushed commits to live projections, including corruption rejection and restart replay. Separate [two-process loopback checks](testing/DB_REPLICA_PROCESS_2026-09-27.md) show applied-position-based catch-up after receiver restart and catch-up from an encrypted stopped-instance baseline. Later community roster, upload revocation and upload publication records reached the fenced receiver. With both upload trees configured, the sender transferred a later file in bounded chunks after database catch-up, and the receiver verified its SHA-256 before publication. The receiver also removed revoked baseline bytes after applying the denial and on restart; its cleanup position is reported separately. An additional opt-in, bounded [sidecar copy lane](deployment/EXPERIMENTAL_DB_REPLICA.md) transferred a later notes change without a new WabiDB commit, removed that file after source deletion, and copied the upload registry in the same disposable process check. It has a fixed allowlist and verified hashes, but no shared database/sidecar checkpoint, completeness watermark or safe promotion. A same-key but divergent commit-prefix fixture is refused before catch-up. Each push carries a target commit-index prefix fingerprint, and a process check rejects a batch that skips an earlier committed entry before applying it; legitimate numeric sequence gaps remain allowed. A [transport integrity check](testing/REPLICATION_TRANSPORT_INTEGRITY_2026-09-27.md) now rejects malformed pull hashes rather than silently zeroing/dropping them, refuses missing or unsafe source segments before push, and reads a shared segment once per batch; the five two-process contract tests still pass. The current sender does not use pull for catch-up. A [two-network field check](testing/REMOTE_FENCED_REPLICA_2026-09-27.md) then moved a disposable stopped baseline from Iyoku to Ronin; with Iyoku's Authority running again, Ronin's fenced receiver advanced from applied/indexed commit 19 to 21 and copied a 4,096-byte later upload with a matching SHA-256 hash. It still reported `fullInstanceReady: false`; the field run did not establish a sidecar checkpoint or promotion. Sync requires the experimental switch and token; the sender checks root-key fingerprint, commit-index prefix and receiver fence, and a writable engine rejects peer ingestion. A [stopped source/passive fixture comparison](testing/REPLICA_STATE_COMPARISON_2026-09-27.md) then found no one-sided data files after live catch-up; its only different file bytes were a derived projection snapshot whose decoded, order-normalized state matched at watermark 19. The development receiver now handles SIGTERM/Ctrl-C cleanly, and a focused process test found its checkpoint and released lock after exit. This remains incomplete whole-instance replication: unregistered uploads, other state outside the sidecar allowlist, deletion-safe retention, sustained convergence and safe writer/failover semantics are not proven. Network replication remains experimental and disabled by default.
- **Session revocation recovery:** the current worktree uses bounded ordered WabiDB deltas for individual-token denials, account/global issue-time floors, current-session exemptions and imported legacy user denials. Startup imports the old JSON file before serving, refuses invalid legacy denial state and resumes an interrupted batch import; a canonical initialization marker makes later stale files non-authoritative. Sequencer preflight refuses stale floors before preparation, and HTTP/live callers now handle failed persistence instead of acknowledging it. A [focused local contract](testing/SESSION_REVOCATION_RECOVERY_2026-09-28.md) covers a fenced receiver and event replay. This is one recovery component; other sidecars, remaining compound operation boundaries, complete checkpoints and distributed fencing remain open. Code state and code-based ownership recovery now have the separate working-tree contract below. Older binaries can read stale denial state after rollback; see [operator guidance](deployment/SESSION_REVOCATION_RECOVERY.md).
- **Code-based account recovery candidate:** recovery-code hashes and consumed-code records now enter bounded ordered WabiDB events after one-time strict legacy import. Code-based recovery spends the code, restores its existing bound account as owner and advances global session revocation in one event/commit. New issuance rechecks the canonical current owner at preparation; stale issuance and code reuse are refused. Owned workers preserve committed publication through cancelled requests. Ordinary ownership assignment also waits for durability and checks a transfer's expected owner. Other ownership/password workflows retain separate writes. See [operator guidance](deployment/ACCOUNT_RECOVERY_STATE.md) and [focused evidence](testing/ACCOUNT_RECOVERY_STATE_2026-09-28.md). Complete-instance checkpointing, unavailable-host promotion and distributed failover remain open; matching readers are required for recovery or rollback.
- **Runtime operation pause foundation:** the current worktree drains participating HTTP handlers, 89 asynchronous Socket.IO callbacks, owned account publication and several background mutation passes through a shared local gate. Nested work shares its lease, and admitted owned work retains it after client cancellation. This is one checkpoint prerequisite; arbitrary direct engine/plugin/external writers and complete database/file coordination remain open. No live exporter, recovery-ready verdict or promotion is enabled. See [the coordination contract](deployment/RUNTIME_OPERATION_PAUSE.md) and [focused evidence](testing/RUNTIME_OPERATION_PAUSE_2026-09-28.md).
- **Coordinated checkpoint boundary candidate:** application drain now pairs with local database commit and inbound-ingestion guards, indexed/applied prefix agreement and the projection snapshot writer held through synchronous copying. The blocking task owns its guards after caller cancellation. Interrupted admitted work vetoes a later checkpoint. This is a local ordering component; complete encrypted live export, operator/plugin/external inventory, unavailable-host promotion and distributed fencing remain open. See [the boundary contract](deployment/CHECKPOINT_BOUNDARY.md) and [focused evidence](testing/CHECKPOINT_BOUNDARY_2026-09-28.md).
- **Encrypted live core archive candidate:** an internal export method now consumes that boundary and streams whole data/uploads roots into age ciphertext with bounded enumeration/copying, per-file hashes and a protected inventory footer. Unknown regular files and empty directories are included; three runtime paths are omitted and the actual running signing/bootstrap keys replace absent or stale persisted key files. The protected header records resolved server configuration and applied-prefix/key continuity. V2 restores always remain inactive and writer-fenced, even without the passive CLI flag; stopped-move activation refuses them. External blacklist and enabled Lore are refused. [Forty-five selected local checks](testing/LIVE_CHECKPOINT_ARCHIVE_2026-09-28.md) passed, including an authenticated opaque-inbox send/fetch and inactive CLI restore, corruption/refusal cases and stopped-backup/boundary regressions. This is working-tree core recovery work, with no operator trigger, complete-instance readiness verdict or promotion. Operator/plugin/external inventory, comprehensive recovery validation, distributed fencing and failover remain open. See [the archive contract](deployment/LIVE_CHECKPOINT_ARCHIVE.md).
- **Stopped-instance recovery and warm standby:** the current working tree has a source-backed [instance inventory](architecture/INSTANCE_RECOVERY_INVENTORY.md), an offline age-encrypted [snapshot/restore tool](deployment/BACKUP_AND_RECOVERY.md#candidate-encrypted-stopped-instance-tool), and a [disposable rehearsal](testing/INSTANCE_RECOVERY_2026-09-26.md) that compared all 19 fixture data/upload files by path, size, and hash, then read the encrypted restore through the Authority API. A separate [encrypted instance inbox](deployment/ENCRYPTED_INSTANCE_INBOX.md) streams an immutable ciphertext copy to another process and returns a hash-checked download; its [loopback contract check](testing/ENCRYPTED_INSTANCE_INBOX_2026-09-27.md) exported, transferred, fetched and restored a disposable data/uploads fixture. A passive restore mode now installs a durable WabiDB writer fence before publishing the restored tree, with a focused restore test. That earlier backup rehearsal did not test hosted data, optional external stores, a second physical host, or a running-server snapshot. WabiDB has a [tested durable local sequencer fence](testing/LOCAL_WRITER_FENCE_2026-09-26.md) that rejects later canonical commits after in-flight application and survives restart. For a planned stopped move, the old tree is fenced before export; the guarded restore requires that archived fence, stays inactive, and refuses to start until `activate-restored` verifies a receipt bound to that encrypted archive. The [disposable controlled-move check](testing/CONTROLLED_MOVE_RECEIPT_2026-09-27.md) covers this path and now also reseeds the retired machine as a fenced passive copy from the new Authority's later stopped state; both old and reseeded trees refuse full Authority startup. A later [two-network field run](testing/REMOTE_CONTROLLED_MOVE_2026-09-27.md) moved the disposable stopped Authority from Iyoku to Ronin, kept the community ID, session, history and upload bytes, accepted a new write, and reseeded Iyoku as a fenced passive copy whose 30 durable file hashes matched Ronin. iRonin and Iyoku were on one network, so this was not a three-site pilot. The receipt is a workflow guard, not remote attestation. A plain restore remains available for isolated backup inspection and separately controlled recovery, so operators must not start both copies. This is not a distributed lease or promotion while the old host is unreachable. The encrypted standby envelope receiver refuses replacement of a stored snapshot ID, but a production-safe live-state exporter/importer/promotion path does not exist. Automatic failover/election is intentionally disabled.
- **Planned-move process preflight:** an optional [Authority plus two-Anchor loopback run](testing/THREE_SITE_REAL_AUTHORITY_PREFLIGHT_2026-09-27.md#planned-stopped-move-through-a-known-anchor-url) exercised encrypted stopped export, guarded restore, receipt activation and a replacement Authority behind the same Anchor URL. It retained a member session, community ID, signed roster, history and upload bytes, accepted a new write and roster update, and refused the old Authority's restart. The disposable run needed to clear a verified stale WabiDB PID lock after clean shutdown. A later [two-network field run](testing/REMOTE_CONTROLLED_MOVE_2026-09-27.md) repeated the planned move and passive reseed on Iyoku and Ronin. Neither run proves unavailable-host failover, an independent three-network pilot or live regional service.
- **Controlled passive move candidate:** `wabi-instance-snapshot` now has `seal-passive-move` and `activate-passive` for a stopped, fenced old Authority and a stopped passive copy whose complete configured data/uploads trees match. The receipt includes an order-normalized projection snapshot and is a workflow guard using the shared persisted root key, not remote attestation. Thirteen focused snapshot-tool tests passed. A [disposable real-process loopback run](testing/CONTROLLED_PASSIVE_MOVE_2026-09-27.md) caught up a fenced receiver to commit 19, copied a later 4,096-byte upload, removed only its empty receiver staging directory, fenced the old writer, activated the matched copy, retained community/session/history/upload reads through the same Anchor URL, accepted a new write and refused old-writer startup. The receiver still reported `fullInstanceReady: false` before the controlled stop. This is one planned stopped boundary on one computer, not a complete live checkpoint, automatic election, unreachable-host recovery, external-store proof or a physical three-site pass.
- **Controlled passive move deletion follow-up:** a later [single-computer process run](testing/CONTROLLED_PASSIVE_MOVE_2026-09-27.md) waited for the source's post-revocation commit position, then verified that the fenced receiver had applied and pruned through it before activation. After the guarded move, the deleted message stayed absent and a revoked 4,096-byte upload remained HTTP 410; the passive upload bytes were gone. A focused Socket.IO regression check also confirmed that a failed durable delete reports an error and leaves the session copy visible. These are current-view and configured-tree checks, not secure erasure, complete retention coverage or a three-network result.
- **Channel-wide history clear:** the earlier Socket.IO action had only dropped its session cache because the persistent store used a no-op default. The working tree now commits a `channel_messages_cleared` event, tombstones the channel's then-visible durable messages in the messages projection, and reports an error without clearing the live view if persistence fails. The UI says that backups, older storage and attachments can retain copies. It now requires live confirmation; new offline clears are rejected and older pending queued clears fail for review instead of replaying. A focused failure/success check passed, and a [later loopback passive-move run](testing/CONTROLLED_PASSIVE_MOVE_2026-09-27.md) kept a cleared channel empty after receiver catch-up and activation at commit 27. The projection pass can be expensive for large rooms, and neither secure erasure nor large-room throughput is proven. Older binaries do not understand the event.
- **Timed-expiry passive-move canary:** a later [single-computer process run](testing/CONTROLLED_PASSIVE_MOVE_2026-09-27.md) observed a five-second message disappear from source REST history, waited for the fenced receiver to reach the source's later commit position, and found that channel still empty after guarded activation at commit 32. This covers one short expiry fixture, not all retention modes, backlog behavior, raw-history erasure or a remote move.
- **Upload revocation recovery:** the current working tree refuses malformed `upload_registry.json` at startup, also refuses a missing registry when uploads already exist (while allowing an empty upload staging directory on fresh boot), and reports persistence failures instead of falsely confirming a revocation. New bytes are staged until their registry entry and an immutable WabiDB publication record with size and SHA-256 are durable; the whiteboard-specific file route honors revocations. Resumable chunks serialize per upload, must append within the declared size, and have an 8 MiB request limit. Completion checks the bytes on disk before syncing the file and, on Unix, the public directory entry. A [disposable local check](testing/UPLOAD_REVOCATION_RECOVERY_2026-09-27.md) covers atomic save, failed save/retry, reload, staging, the missing-registry startup guard and the upload route's size/offset behavior. Revocation decisions enter ordered WabiDB events; a fenced development receiver applied one after a stopped baseline, removed the matching passive file, and startup can repair a stale local registry. New publication records and explicitly enabled verified byte copying cross the experimental replication path. A stale registry can regain canonical entries at Authority startup only after the matching nonrevoked files are present and hash-checked. Older uploads lack canonical publication records until explicitly backfilled; an opt-in sidecar lane can copy the registry but has no shared ordering boundary with the database or upload files. Deletion from the active and configured passive upload trees does not securely erase caches, backups or historic raw stores.
- **Upload publication crash recovery:** a focused Authority restart check covers the gap after `upload_published_v1` commits but before the private staging file reaches its final path. Startup can finish both direct and resumable uploads only when the staged file matches the canonical size and SHA-256; changed bytes refuse startup and an uncommitted staged file remains private. The staging directory is synced before publication commits, and startup hashes all canonical published files, which can slow startup for large upload trees. This repairs one local crash window, not a whole-instance live recovery path.
- **Legacy upload backfill:** an explicit [stopped-Authority tool](deployment/LEGACY_UPLOAD_BACKFILL.md) can preview and then migrate bounded batches of registered older files into `upload_published_v1` records. It skips missing and revoked names, refuses altered file shape or conflicting metadata, and refuses apply mode on a fenced/inactive data tree. Thirteen registry tests and a disposable command test passed. A [two-process loopback check](testing/DB_REPLICA_PROCESS_2026-09-27.md) then copied one newly backfilled file after an encrypted baseline. With sidecar copying enabled, the corresponding registry update also reached the passive tree; the published event and verified bytes provide a separate reconstruction path when the registry is stale. This does not backfill unregistered files or establish complete recovery or safe promotion.
- **High availability:** Wabi does not currently claim production active-active, automatic Authority failover, or split-brain-safe multi-writer state. The legacy in-memory heartbeat helper now reports a timed-out primary as down rather than declaring promotion; a focused WabiDB test passed. It is not wired to writer admission and supplies no quorum, epoch or lease.

### Clients and ecosystem

- Native phone clients are active work; Android/iOS release and physical-device acceptance are not yet a product guarantee.
- The runtime plugin framework is still being hardened. Operator-installed backend plugins should be treated as trusted code, not as safely sandboxed adversarial code.
- Broader profile/gaming/Steam work and additional social UX may exist on development branches; it is not a main-product claim until integrated and verified.
- Animated chat backdrops and other visual experiments may exist on branches without being part of the current release boundary.

### Calling

Calling works, but performance and correctness work continues across browser/native clients, reconnects, larger calls, screenshare, media transport, and real two-device/network acceptance. Synthetic/headful browser coverage is valuable but is not a substitute for physical-device certification.

## Explicitly not claimed today

- Independently verified end-to-end encryption for DMs/private rooms.
- Operator-blind private content.
- Federation between independent Wabi servers.
- Global Wabi identities or a global username directory.
- Cross-server DMs implemented by servers talking to one another.
- Production active-active community state.
- Automatic backend failover / Authority election.
- Production-ready WabiDB peer replication or standby restore.
- A full CAD editor, parametric modeler, or authoritative DWG solid-model renderer.
- PDF/EPUB support in Reader unless/until those importers actually ship.
- Fully sandboxed untrusted plugins.
- A production-certified native mobile release.
- A built-in music streaming/catalog service. Music integration remains a rights/legal/product decision rather than something to bolt on casually.

## Privacy boundary

Wabi is privacy-oriented through self-hosting and minimized central dependence, but **self-hosted does not mean zero-trust**.

- The server operator controls the instance and can access server-readable content.
- New DMs/groups in the Tim rollout begin encryption-pending and may move to experimental encrypted text after participant devices are ready. Updated clients also upgrade future messages in older readable rooms when all devices are ready, unless server-readable mode was explicitly selected; historical plaintext remains readable. Explicit server-readable fallback needs each sender's confirmation. First-seen device keys come from the Authority, and the full client/protocol has not been independently verified.
- Retention and confidentiality are separate. A message that is not retained after its configured lifetime is still visible to the server while it exists.
- Client-local preferences/effects/queues remain a different trust boundary from server state.
- Optional reverse proxies, tunnels, DERP relays, media services, external tools, and plugins add their own operators/software to the trust chain.
- Translator Assist does not use the Authority as a translation relay. A remote self-hosted translator is nevertheless another plaintext recipient for any text the user asks it to translate; localhost translation keeps that additional processing on the user's device.

See `PRIVACY_STANCE.md` and `SECURITY-MODEL.md` for detail.

## Release-readiness gates that matter most

The next meaningful confidence gains are not more feature-count checkboxes. They are proof that the existing product behaves correctly under failure and real use:

1. **WabiDB recovery** — keep restart/replay/crash tests green on the release candidate. The September 15 audit did not reproduce the previously unspecified regression; a real candidate backup/restore drill remains a separate gate.
2. **Backup/restore drill** — take a real stopped-server backup, restore it to a clean host, prove accounts/content/readiness, and document the exact supported compatibility boundary.
3. **Physical call matrix** — two real clients across representative networks, including reconnect, screenshare, audio routing, and optional TURN/SFU paths.
4. **Authorization audit** — continue endpoint/socket/admin permission review and preserve deny-by-default behavior for private resources.
5. **Desktop release checks** — platform packaging, upgrades, permissions, and sidecars on supported OSes.
6. **Mobile acceptance** — native build → emulator/device → network/media/background behavior before claiming mobile release readiness.
7. **Plugin trust boundary** — verify permission enforcement/sandbox expectations and make the UI/docs match what is truly isolated.
8. **Multi-node acceptance, later** — only call replication/standby HA after two-node convergence, restart catch-up, deletion semantics, passive-writer rules, Anchor realtime behavior, real export/import, and a tested manual promotion runbook all pass.

## Documentation rule

Use these labels consistently:

- **Available** — integrated into the current product line and has a real runtime path.
- **Optional** — available but requires explicit operator configuration or an external helper/service.
- **Experimental** — source exists, but correctness/release acceptance is incomplete and the feature should fail closed by default when safety matters.
- **Planned** — design or branch work only; do not describe it in present tense as a shipped capability.

When a feature crosses one of these boundaries, update this file, the root `README.md`, and the relevant architecture/deployment document in the same change.
