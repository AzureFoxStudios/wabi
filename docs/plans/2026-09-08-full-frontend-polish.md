# Full frontend polish — 2026-09-08

Status: documented repair pass deployed; **comprehensive product UX remains open**.
The user explicitly rejected treating these repairs as full polish. Release and
historical verification are recorded below. No native installer or real-device
test is claimed by this pass.

The user explicitly approved completing the September 7 frontend-polish document
with parallel subagents. Its historical recon-only pause and single-worker budget
guidance no longer govern this implementation. Original recon evidence is retained.

## Objective and ownership

Remove the documented, user-visible warts while making controls honest. Existing
workspace navigation changes are retained. The parent owns draft/session safety,
Settings/dialog behavior, DM identity fallbacks, shared integration and verification.
Disjoint agents own role-management correctness, admin presentation/emoji controls,
and sidebar/drawer/Notes/audio settings. No speculative design-system rewrite.

## Findings and implementation

| Severity / issue | Before | After / intent | Why |
| --- | --- | --- | --- |
| High, workspace switching/drafts | Full workspace mounts discarded composer-local text and Files; uploads read changing destinations after awaits | Session-memory account/channel/surface drafts, immutable send destination and retired-editor/upload fences | Navigation must not lose unfinished work or redirect private attachments |
| High, UI-10 role management | Blank mismatched catalog; rename changed caller membership; lowercase assignments and concurrent removals contradicted authorization/read models | Built-in read-only role reference, canonical validated role command, live/reload representation, server receipts | Polishing a broken permission control would expose a real integrity bug |
| High, UI-08 settings | Four audio switches had no consumer; Add-ons counts changed while stable callback props left controls stale | Remove no-op audio rows; label real/native controls; reactive filter snapshots update all nine Add-ons sections without losing edits | Controls and searches must do what they advertise |
| Medium, UI-16 pins | Pin serialized the old panel; startup home-preference commands then overwrote a correctly saved/restored pin | Synchronize runtime/persistence and give saved layout sole restore ownership; explicit home choices remain commands | Preserve selected and intentionally closed docking across real reloads |
| Medium, UI-04/14 overlays | Settings left focus outside and Escape failed; Dashboard Back revealed hidden Profile tab | Shared modal focus ownership; opening Dashboard closes Settings; Back returns to app | Predictable keyboard and navigation context |
| Medium, UI-01/15 sidebar/drawer | Zero-size unstroked chevron; drawer ignored keyboard, exceeded short viewport | Explicit SVG geometry/currentColor; bounded, portaled drawer with focus/navigation/return | Visible controls and reachable actions |
| Medium, UI-07 Notes | Hidden title, duplicate empty copy, forced desktop columns in tiny center panes | Clear title/empty action, responsive list/editor based on available width | Notes must work in both mobile and narrow docked layouts |
| Medium, UI-11/12/13 admin | Counts read as 480%; thousands of raw emoji IDs; overflow at390px | Separated count/percent, upstream human metadata/search, wrapping controls/mobile section navigation | Readable truthful dashboards without changing identity IDs |
| Medium, unavailable automation | Role-rule UI emits events for which server has no handlers | Explicit unavailable state; no fake-success Add/Delete | This pass does not invent a new automation persistence subsystem |
| High, unavailable channel gates | Minimum-role selector appeared to restrict public channels but handler did not persist an enforcement policy | Explicit limitation; no simulated private-channel selector | Public channels must not be presented as private; DM/group authorization is separate |
| High, ineffective Ban | Menu promised exclusion, but handler only emitted unhandled notifications with no persistence or enforcement | Remove false Ban action, reject legacy command, retain old queue records as non-retryable failures | Existing separate blacklist enforcement is untouched; role demotion is not account revocation |
| Medium, dashboard truthfulness | Unsupported counters/feeds showed zero; fractional count animations and unconditional System Online status; wrong role badges | Availability metadata, honest empty states, immediate integer counts, no static health claim, normalized roles | Unknown is not zero; decorative animation must not misrepresent state |
| Low, UI-09 recipient identity | Partial offline snapshots could show Unknown or an unexplained generic DM | Shared resolver uses participant summaries; unresolved recipient is honestly labeled with refresh guidance | Do not guess recipient from message authors or silently delete an orphan conversation |
| Medium, UI-02/03/05 (earlier batch) | Workspace picker moved, overlapped narrow panes and discarded keyboard focus | Persistent labeled picker with native touch/keyboard access and return to Messages | One navigation owner outside changing surfaces |
| UI-06 (previous release) | Raw Storage keys and misleading archive/retention controls | Existing storage-boundary fixes preserved | No new private archive or unsupported deletion claim |

## Design review (full mode)

Framework: Svelte 5, existing plain CSS and semantic tokens; default dark and light,
desktop/narrow desktop/mobile, keyboard and reduced motion are the test targets.

| Category | Evidence / result |
| --- | --- |
| Typography | Counts/percent separated; Notes context restored; descriptions use existing type scale |
| Surfaces | Constrained center panes, modal/drawer containment and touch targets; structural dividers retained |
| Icons | Existing SVG/currentColor retained; chevron fixed; human OpenMoji metadata preserves IDs/assets |
| Motion | No new high-frequency animations; picker inspected at 10% playback; reduced-motion checks retained |
| Performance | Bounded emoji result pages, no new UI framework/runtime metadata download; exact-property transitions |

Rejected alternatives: keep hidden Chat/capture mounted to retain drafts (media
ownership risk); persist plaintext drafts to localStorage (unnecessary private
archive); invent editable role labels without existing persistence (false feature);
replace all icons/styles (unrelated churn); hide overflowing controls (unreachable
functionality rather than a responsive solution).

## Verification log

- Before pin fix, isolated real app: `{pin: notes, savedPanel: users, collapsed: false}`.
- First headful integration pass: drafts/text+File survive six workspace roundtrips;
  Settings initial focus/Escape/Tab containment, all 11 Settings entry states,
  Dashboard Back, workspace/picker scenarios, drawer keyboard/short viewport, and
  Notes creation/mobile editing passed before the expected pin snapshot failure.
- Final frontend check: zero errors, 145 existing warnings in 40 files; 518 unit
  tests passed, 12 crypto tests skipped by their existing environment guards.
- Expanded real-capture fixture audio suite: all 8 routes passed, including Audio
  settings native-gate/label behavior and call transports/reconnect/panel ownership.
- Independent review added explicit session-clear ABA coverage and per-draft
  pending handoff settlement, so partial split failure retries only unsent text.
- Attachment handoffs use the same pending ownership and consume accepted File
  objects by identity without clearing newer caption/files/reply edits.
- Real SocketManager/IndexedDB browser checks passed profile/account isolation,
  group/reconnect safeguards and retained non-retryable unsupported Ban requests.
- Both browser and simulated-Tauri storage-boundary checks passed. These exercise
  actual IndexedDB and UI, not a native WebView or installer.
- A normal-parallel server run exposed interference among existing header-cache
  tests: the capacity test evicted other tests' global-cache entries. Serial run:
  437 passed, 2 ignored. A test-only shared fixture lock now isolates those five
  scenarios; runtime audio code was not changed. Final normal-parallel run:
  438 passed across 18 suites, 2 ignored (including the executed subprocess helper).
  One intermediate Lore stub-CLI test hit transient Linux ETXTBSY; the serial and
  final parallel runs passed. No Lore runtime change was made for that flake.
- Final full-app headful suite passed: text/File drafts through six workspace
  roundtrips; text and attachment pending handoffs/remounts; partial/queue/upload
  failures and newer edits; explicit logout/re-login boundaries; all 11 Settings
  entries; all 9 Add-ons accordions/search with unfinished-edit retention; all 8
  Admin sections at desktop and 390px; emoji selection writes a real preference;
  workspace keyboard/touch/narrow-pinned/light/reduced-motion scenarios; honest
  lazy-load failure escape; Notes editing; drawer bounds; acknowledged pin and
  explicitly closed dock across reloads. Zero uncaught application errors.
  Final evidence: `/tmp/wabi-workspace-smoke-bIYDr0`.
- Embedded screenshot review exposed a mobile Add-ons height trap: the desktop
  260px width basis became a tall column child inside a half-screen inner cap.
  Mobile Settings now owns scrolling; search is reachable by actual pointer
  hit-test, with no clipped inner accordion. Full headful suite passed again.
- Pin restore diagnostics prove server/local/runtime agree after reload:
  `notes / pinned / collapsed:false`, then `null / none / collapsed:true` after
  explicitly closing and saving. A late preference refresh no longer overrides it.
- Tauri frontend (including CodeMirror) and static frontend builds passed, in
  that order. Release server rebuilt with the final static assets. Independent
  headful verification against that embedded binary passed a real local UI login,
  workspace draft roundtrip, Add-ons search/selection and desktop/mobile Admin.
  No Vite or injected auth token in this final check.
  Embedded evidence: `/tmp/wabi-embedded-polish-Shccyr`.
- OpenMoji checksum check passed; all original fields/order/IDs preserved across
  4,284 records. Unicode compatibility, diff check and both skill validators pass.

Verification logs: `/tmp/wabi-full-polish-{check,unit,browser,embedded,group,storage,media,role,server-tests,tauri,static,server-build}.log`.
The interface skill influenced motion restraint, keyboard focus/targets, semantic
surfaces and human labels; the architecture/offline skills guided ownership and
truthful persistence claims. No WabiDB schema, projection, postcard or generated
protocol changes were made.

**Verdict: Pass for this documented repair pass.** This is not launch certification
or a claim that every reachable feature/control has exhaustive QA. All isolated
test servers/browser processes were stopped; scratch evidence remains available.

Entry-state coverage is not exhaustive correctness testing of every addon. Lore
remains external/optional. No live credentials, production mutations, physical
microphone capture, host package install, or native installer was used.
Unresolved historical DM data was not repaired or deleted: participant-summary
fallback and clearer unavailability address presentation, not an unproven cause
in a live database. Durable bans, public-channel role gates and reaction-role
automation remain unsupported, not completed features. First-device accounts
with a home preference but no saved layout use the schema's normal People
fallback; explicit registration/Settings choices still apply.

## Authorized release — 2026-09-08

GitHub `origin/main` matched the local base `3730a533` at release review. The
exact tested addon-enabled artifact has SHA-256
`5afb0df682c0d1f8f118a94ad27eb55c6d775d61dccabe32845b8467f4516621`;
three Lore initialization markers are present. Static assets were built last
and embedded before the successful independent UI-login smoke recorded above.

Initial live preflight: public `https://wabi.chat/` remains HTTP 200 with
`no-cache`, but Ronin-to-Tim SSH times out while Ronin's Tailscale reports a
coordination-server connectivity warning. The Ironin route reaches a fresh SSH
authorization checkpoint. No live service has been stopped or artifact swapped.
Deployment is not complete until actual host inventory, rollback protection,
exact-artifact swap and live checks succeed. Old deployment recipes contradict
the current Dockerfile and lock/account safety rules; do not follow their
live-registration probes, broad source sync or unverified lock deletion.

### Completed push and deployment

The SSH check was subsequently authorized. Implementation was pushed to
`origin/main` as `ec4af0f118d2a454d429ee5c4297254ee6810795`. Tim started the
candidate at **2026-09-08 03:49:11 UTC** (10:49:11 Bangkok). Both `/wabi-server`
and the running `/proc/1/exe` match the candidate SHA-256 above.

- Tim's existing Fedora runtime uses glibc 2.43 and is compatible with the
  candidate. Only the bind-mounted binary changed; the container, keys, Lore
  mounts, tunnel and coturn configuration were retained.
- Consistent stopped-server backup and a separate immediate-cutover backup are
  retained in private `/home/tim/Desktop/Wabi/release-polish-20260908.v9OfSx`.
  Old binaries and stale locks are recoverable there. Both lock paths were
  checked only after the owning process stopped. No user data was deleted.
- Candidate replay on a separate copy, same image/UID, `--network none` and no
  live writable mounts passed readiness, owner-marker, enabled-Lore and all 21
  exact embedded asset checks. The preflight container is stopped, not a second
  background service.
- Origin and public health pass from Tim; public health/liveness/readiness,
  anonymous channel/admin denial, unknown-API JSON 404, `no-cache` HTML, all 21
  referenced asset hashes and Engine.IO handshake pass from Ronin.
- Headful Chromium renders the actual public login at desktop and 390px without
  uncaught application errors. This is unauthenticated live smoke, not a
  real-account login, physical phone, native installer or two-device call test.

Evidence: `/tmp/wabi-polish-{backup,preflight,swap,public}.log` and
`/tmp/wabi-polish-release-2rHPLk/`. Existing browser tabs need a reload; bundled
Tauri clients require a matching client build to receive frontend changes.

Next coherent objective: truthful message acceptance and durable message
reconstruction. The existing socket path can acknowledge/broadcast after a WDB
failure, while file payload decoding/history reconstruction can lose ordinary
attachments after restart. This release does not claim those independent defects
fixed; its session-memory draft improvements are not server persistence receipts.

### User review: full product UX reopened

The user's hands-on review found this repair pass insufficient: the new dropdown
workspace picker loses the appeal of the original compact expanding icon bar;
Admin still does not provide a useful route to server administration or meaningful
reports/operational information; Whiteboard has redundant text; and Settings and
Add-ons were not examined deeply enough. Entry/search coverage was real but must
not be represented as proof of useful completed workflows.

Finish the [message-delivery stretch](2026-09-08-message-delivery.md), then perform
a thorough task-based UX/UI pass across **all** product surfaces: channels, chat,
forums, Lore, wiki, whiteboards, right panels, server hub, every Settings/Add-ons
section, and other reachable workspaces. Trace actions through actual consumers
and server contracts. Review creation/editing/discovery, permission boundaries,
loading/empty/error states, navigation and desktop/narrow layouts. Fix and verify
one coherent area at a time. Unsupported-feature honesty is necessary, but a
label explaining the absence of functionality is not itself product polish.
The expanding icon-bar interaction and Admin information architecture require
reconsideration, not automatic preservation of the previous implementation.

Design exploration requested separately: expandable forum-post entries below
their parent channel (a sub-channel-like tree). This is **not mandatory
implementation**. Compare with existing channel folders/tree and right panels;
evaluate discovery, unread state, bounded nesting, sidebar noise and narrow
layouts before deciding whether it fits Wabi.

Additional evidence from the delivery full-app regression: Admin sections still
logged `not_found` for relay roster and donation configuration/audit requests.
Investigate the actual endpoint, availability and setting-consumer contracts;
do not count a mounted section or caught console error as a working control.

### Right rail: clarified product constraint and pop-out exploration

Ronin clarified the intended model during the live-browser reconnaissance:

- The rail is **additive and user-customizable**, not a fixed navigation sidebar.
  Start with People, DMs and Notes; users can add, remove and reorder stubs. Keep
  the permanent add/recovery control available even when every stub is removed.
- Show **one active right-hand panel at a time** beside center stage. Peek is
  temporary; pin keeps that panel open. Do not interpret multitasking as permission
  to stack People, a conversation and several other panels in the main window.
- Explore **Open in another window** for deliberate additional views, including
  Tauri. This is an exploration, not a requirement to expose every panel before
  its detached lifecycle works. Preserve the main window's selected workspace,
  drafts, account boundary and media ownership.

This explicit clarification supersedes historical multi-stack design descriptions
and the reconnaissance's initial assumption that simultaneous dock panels were
the goal. Do not flatten the customizable rail or remove tools for screenshot
cleanliness. If the extra quick-note surface is consolidated, preserve its saved
contents and provide a reachable editing path; it is not the same store as Notes.

Confirmed in the current source and live desktop render: `RightPanel.svelte`
renders one `WorkspacePanelHost`, but also mounts `QuickResourcesPanel`
unconditionally underneath it. At 1440×900, the selected panel occupied 660px of
height and that separate Notes/DM block occupied 240px. The latter is a separate
layout decision, not evidence that the rail needs to lose customization.
`layoutStoreRightPanel.ts` already has one displayed tab and a committed pin;
temporarily previewing another tab restores the pin on dismissal.

The existing channel menu's `Open OS window` calls `openDetachedPanel`; a
`workspace-panel` detached route also exists. These are **not yet a verified
reusable window contract**: the opener does not hand off session-only credentials,
and the Tauri capability currently covers only `main` with `core:default`, not
the required new-window creation permission or detached-window capabilities.
The channel route calls `joinChannel` but renders the global-current-channel
`Chat` without explicitly selecting its requested channel. Validate actual
channel targeting and authentication before extending this path. No credentials
should enter a detached URL. Do not duplicate active calls/transfers or claim
unsaved drafts moved just because a new browser context opened.

Recommended first pop-out slice: repair the existing channel-window path before
adding panel callers. Give creation/authentication honest pending/error states,
bind the requested server/account/channel, cancel retired bootstrap work, and
propagate logout across windows. Add only the necessary native capabilities.
Keep editors independent until a real draft handoff exists. Editable Notes also
needs cross-window storage conflict handling: separate instances currently write
whole local snapshots. Calls and Transfers require deliberate ownership, not a
second instance of their controls. The in-app `Open floating panel` option is
separate again: its host currently renders placeholders rather than live Chat.

Verification in this reconnaissance: an isolated, visible browser inspected the
actual deployed shell and computed panel geometry; no live content was sent,
settings saved, or layout controls changed. Local
`bun test src/lib/rightPanelStubStrip.test.ts src/lib/panelPopover.test.ts`
passed **32 tests / 78 assertions**. These prove existing store/popover cases,
not detached browser authentication, native Tauri windows, draft handoff, or
cross-window call behavior. No UI implementation, push or deployment belongs to
this reconnaissance checkpoint; the comprehensive surface review remains open.

### Administration follow-through — implementation and acceptance in progress

The next coherent objective is a useful, authoritative Admin workspace, not a
second decorative dashboard. A fresh visible-browser owner login on wabi.chat
confirmed overlapping member/recovery controls in personal Settings and large
placeholder panels in Overview. No live accounts, policies or content were
changed during that inspection. Private screenshot evidence is outside the repo.

Implemented locally:

- Personal Settings launches specific Admin destinations; it no longer mounts
  duplicate management forms. Admin has Overview, Server health, People, Roles,
  Channels, Branding and Payments. Moderator navigation only exposes People;
  it does not request admin-only statistics.
- Overview uses actual account/presence/channel counts and a bounded latest-ten
  role/channel-settings history. There is still no report intake/read model:
  this activity is not advertised as a moderation queue. No fake message counts,
  top-contributor table or guessed event timestamps.
- Health reports writer liveness, projection health, monotonic uptime and
  nullable Linux process RSS. Full-width database sequence values remain strings.
  This is not host CPU/disk monitoring, backup/replication health or a complete
  integrity scrub. The dashboard's reads are not transaction-isolated snapshots.
- One account/server-scoped read owner coalesces polling and Refresh, bounds hung
  requests and discards retired results. Read failures retain an explicitly stale
  snapshot; authorization loss clears privileged data. Ready is never inferred
  from a successful HTTP connection.
- User/channel projection query failures propagate instead of producing
  misleading partial rosters/counts. Legacy decoding and tombstones remain
  supported. Audit history uses its existing big-endian sequence index, not an
  unbounded decode/sort. No domain event, postcard field or index encoding changed.
- People has a real permanent password reset, protected self/owner/guest targets,
  explicit confirmation and failure states. Message targets the chosen member's
  canonical DM, joins that room and returns to the main workspace. Self-message
  opens Notes. No nonexistent lockout-clearing/purge controls remain in Settings.
- Reset follow-through exposed an immediate-login cutoff bug: newly issued tokens
  could predate the revocation floor. Account minting now takes a coherent
  revocation snapshot, preserves TTLs and rejects password/refresh proofs retired
  by a concurrent reset. Repeated user/global revocation advances monotonically.
- Payment policy edits and enforcement share WabiDB. Legacy import is admin-owned,
  serialized against saves and only allowed when the canonical row is absent.
  Malformed state fails closed. The frontend renders the real server actor rather
  than guessing access from token presence. Empty allowlists remain deny-all.
  Headers-based payment/Admin routes share account-token/revocation validation.
- Payments has one loaded draft/published baseline, guarded Save, local Discard,
  role/guest controls and a route to individual restrictions in People.
  Inert upload/download/community-node/Node runtime editors were removed from the
  reachable workspace; existing saved configuration remains intact.
- Branding edits a loaded draft and publishes explicitly. Actual file drops feed
  the upload handler, not a second picker. Invalid partial color input remains
  editable without being published. The existing policy file is atomically
  replaced; storage errors cannot masquerade as publication. Boot HTML caches
  the policy content rather than a separately sampled mtime, preventing a rename
  race from pinning old artwork under a new timestamp.
- Shared HTTP retry ownership is part of the same administrative boundary.
  Previously an old request could retry with the newly selected account/server's
  access token, and repeated 401s could recurse indefinitely. apiRequest captures
  the destination/session/credential, bounds retries and respects cancellation;
  authRefresh coalesces by session generation. Denied refresh still returns 401
  for login recovery. The generic fetch deadline ends at response headers;
  policy reads and artwork uploads separately bound body consumption.
- Roles leads directly to People. Channels lists supported ordinary channel
  kinds and composes the existing workspace/channel navigation, retaining the
  dock and never issuing a media join. Public-channel role gates remain absent.
  The right rail's customizable single-panel/pin model is unchanged.
- A real badge assignment/removal check exposed a dropped SocketIo::emit future:
  the WabiDB change persisted but the live update was never sent. Both broadcasts
  are now awaited and delivery errors logged; the domain/projection encoding is
  unchanged. A successful compile was insufficient to catch this behavior.
  Both mutations also use current socket authorization. Private request IDs
  correlate errors across navigation; the client keeps one pending action,
  confirms only authoritative badge state, and explains rejection or an
  unconfirmed result without optimistic badge changes.
  The existing user_badges prefix query also now fails on corrupt JSON rows
  instead of silently returning a partial list. Mutation readback propagates
  that failure as uncertainty and emits no synthetic list or success receipt;
  init-only decorative fallback remains separate. Existing badge event/index
  names, JSON records and optional legacy timestamps are unchanged.
- The shared socket revocation helper had an expired-token bypass: cached
  handshake identities outlived exp, but revocation decoding rejected expired
  tokens and treated decode failure as unrevoked. Established sockets now verify
  original signed claims without exp enforcement for the revocation lookup only.
  This preserves healthy-call continuity while retaining user/global revocation
  floors. New handshakes still enforce expiry. Invalid credentials fail closed.

The interface skill guided readable hierarchy, scoped surfaces, wrapping actions,
44px narrow targets, explicit draft states and removal of ornamental count
animations. The API/projection skills were updated with the actual ownership and
read guarantees. Rejected alternatives: invented host/report metrics, another
settings database, styling ineffective policy forms, expanding all dock panels,
and changing the established call or optimistic-message ownership.

Verification underway (not a release sign-off):

- Initial focused projection/engine gates: 283 + 17 passed.
- Real Admin/audit replay contracts: 12 passed; payment migration/auth/access
  contracts: 8 new + 6 existing passed before the immediate-login follow-through.
- Frontend typecheck: 0 errors, 144 existing warnings in 39 files. Tauri frontend
  and static web builds passed, in that order. No native installer/WebView test
  is implied.
- Complete serial server suite with inherited WABIDB_ROOT_KEY removed:
  466 passed, 2 intentionally ignored (includes lib tests also executed in the
  binary target). Full WabiDB library suite: 907 passed. Earlier parallel Lore
  stub-CLI ETXTBSY failures disappeared under the serial run. A preceding run
  with an explicit root-key environment value failed the first-boot fixture
  because that fixture intentionally tests unconfigured startup; the corrected
  environment passed. Neither failure was hidden or treated as runtime proof.
- Full visible-browser application run passed using the current debug server,
  isolated WabiDB/accounts and Vite. All seven Admin sections fit 1440/1000/390/320;
  real measurements/counts, stale-503 recovery, Settings launchers, permanent
  reset/old login and token rejection/immediate new login, new/reused DMs,
  real role audit readback, payment denial/enable/role changes, failed-save draft
  retention, actual artwork drop and identity publish/reload were exercised.
  Evidence: /tmp/wabi-workspace-smoke-2qNyrp (private local artifacts).
- The adverse composer fixture explicitly retires/reinstates a session. Subsequent
  acceptance scenarios reload the application before expecting fresh socket
  listeners; a false duplicate-DM failure from reusing retired listeners was a
  fixture isolation bug, not evidence to weaken server DM correlation.
- Eight synthetic headful audio routes passed. Final shared-request, compatibility
  role-name, light-text contrast and channel-navigation follow-through is in the
  final browser/build gate; previous frontend builds alone do not certify it.

Still open: whole-product review, genuine public-channel permission controls,
report moderation, upload/resumable size enforcement, separate-window ownership,
and revocation-file durability under disk failure. Password storage and session
revocation are not an atomic cross-store transaction. Do not claim restart-safe
force logout during failed filesystem writes based on these tests.
Individual-jti revocations retain the pre-existing exp+1h pruning limit, even
though established sockets can live longer. A future security objective needs
active-socket retention/eviction for that narrower token-only operation; use
account/global revocation for lasting exclusion in the meantime. Malformed or
unreadable auth-admission policy still falls back to defaults and remains an
explicit launch-security follow-up, not a guarantee of this Admin pass.

#### Administrative interface review — full mode

Scope: Settings' Admin entry and the seven reachable Admin sections, including
recovery, messaging, payment and branding interactions. Svelte 5, existing plain
CSS/semantic tokens and the existing icon system; no new styling framework or
asset pack. Other workspaces were traversed for regressions, not signed off as
visually finished.

| Category | Evidence inspected | Result |
| --- | --- | --- |
| Typography | Actual dark/light screenshots; computed foreground/background contrast for Admin descriptions, health labels, recorded actor labels and branding helpers | Readable secondary tokens replace faint light-mode metadata; scoped browser checks require at least 4.5:1 |
| Surfaces | 1440/1000/390/320px Admin sections, real recovery dialog and failed-save states | Wrapping actions, 44px People/recovery/navigation targets, no horizontal clipping in tested sizes |
| Icons | Admin nav, People actions and existing WorkspacePanelIcon renderer | One currentColor icon family; labeled actions and no new decorative asset system |
| Animations | Dashboard counts, existing modal transitions and broader reduced/10%-speed navigation checks | No fractional count/ornamental dashboard animation; no new high-frequency motion |
| Performance | Stats read owner, audit query, section loaders and overlay teardown | Coalesced bounded reads, bounded audit history, section-scoped fetches, cancelled retired uploads; not a load-performance benchmark |

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| High | Settings.svelte, settings/AdminSettingsTab.svelte, AdminCenterStage.svelte | Overlapping duplicate management forms and fragmented destinations | One Admin workspace with targeted launchers and role-gated navigation | One ownership model; predictable focus and navigation |
| High | admin/OverviewSection.svelte, admin/ServerHealthSection.svelte, adminDashboardResource.ts | Placeholder feeds, unavailable counts and stale/unconditional health | Measured counts/health, bounded recorded changes, stale/error/access-loss states | State feedback must describe actual backend behavior |
| High | admin/AdminPasswordReset.svelte, adminPasswordReset.ts | Recovery action without a coherent confirmation/error/session lifecycle | Protected targets, matching passwords, permanent-reset semantics, focus containment and secret teardown | Prevent misleading or unintended sensitive actions |
| High | adminUserMessaging.ts, admin/AdminUserList.svelte | Message action could fail or target a disconnected/retired context | Canonical new/reused DM, joined room, immutable recipient/session and explicit failure | Preserve recipient and transport ownership |
| Medium | admin/AdminUserList.svelte | Crowded actions, redundant Users heading and permanent badge-control clutter | Wrapping labeled actions, touch targets, real badges in disclosure and truthful restriction labels | Hierarchy and progressive disclosure without removing supported actions |
| High | admin/PaymentAccessPanel.svelte, adminPaymentPolicy.ts, payments/paymentAccessStore.ts | Two policies, guessed permission, no reliable published baseline | Canonical enforcement, server actor, retained draft/error/retry/Discard, exact-role compatibility review | A visible control must govern the action it advertises |
| High | admin/FrontendMetadataPanel.svelte, adminBrandingUpload.ts | Picker reopened on drop, partial color lost, failed writes could appear published | Actual File drop, stable editable color input, explicit publish, bounded/cancelled upload and honest save state | Draft is not publication; failure must preserve work |
| Medium | admin/RoleNamesPanel.svelte, admin/ChannelAccessPanel.svelte, adminChannelNavigation.ts | Stale Users reference and disclaimer-only partial channel list | Direct People action, supported channel inventory and dock-preserving canonical navigation | Help users reach the real task without inventing access controls |
| Medium | styles/components/admin-workbench.css, admin/FrontendMetadataPanel.svelte | Faint small text in the light theme | Existing secondary tokens and readable status mixtures | Small informational text needs sufficient contrast |
| High | AdminWorkspace.svelte, settings/ServerSettingsTab.svelte | Reachable inert quota/runtime/purge controls | Removed unreachable promises from normal navigation; saved data retained | Do not style a setting into appearing functional |

Considered but rejected: invented report/CPU/disk metrics (no trustworthy read
model), a second settings store (would repeat the payment split), an expanding
multi-panel dock (contradicts the user's single-panel constraint), and automatic
legacy-role normalization (could grant access without intent). The actual
post-projection badge broadcast was repaired rather than adding an optimistic
badge UI that would hide missing realtime delivery.

#### Final local Admin acceptance

The scoped Admin implementation is approved for delivery; comprehensive product
UX remains open. This is not a launch-security or whole-product visual sign-off.

- Final frontend library suite: 618 passed, 12 existing environment skips,
  19,410 assertions. Typecheck: zero errors, 144 existing warnings in 39 files.
  Tauri frontend and static web builds passed, followed by the release server
  build with addons. No native bundle/WebView installation is implied.
- Final serial server suite: 484 passed, 2 intentional ignored (includes repeated
  module/lib/binary test execution, not 484 unique scenarios). WabiDB library:
  909 passed. Real socket tests prove badge fanout, correlated receipts, revoked
  actors rejected without writes, and committed-but-unreadable badge outcomes
  returning uncertainty without a synthetic list. Expired established-token
  revocation checks preserve normal call continuity and account/global floors.
- All eight headful synthetic audio routes passed again after the shared HTTP
  retry changes. No physical microphone, native WebView or two-device test is
  claimed by that fixture run.
- Final release-backed/Vite headful suite passed all original workspace,
  composer, Settings, nine Add-ons, dock/pin and reduced-motion scenarios, plus
  the seven Admin sections at 1440/1000/390/320, dark/light text contrast,
  account reset/immediate login, DMs, role and real badge mutations, controlled
  late badge errors across navigation, individual payment blocks, published
  payment enforcement, exact legacy role-name review, branding drop/publish/
  reload and replacement-account request fencing. Admin channel opening keeps
  the real pinned People panel across text/forum/wiki/voice without acquiring
  media. Evidence: `/tmp/wabi-workspace-smoke-4VsZg9`.
- The stronger pin fixture initially used the visible label `people` as a
  registry ID; runtime correctly normalized that unknown ID to `users`. The
  fixture now uses the stable `users` ID. No product change was made for that
  test failure. The earlier actual badge-broadcast failure was fixed in source.
- Independent headful acceptance against the actual minified embedded release,
  without Vite or injected login tokens, passed real UI login, workspace draft
  roundtrips, accepted message rendering, all seven Admin responsive sections,
  real health/stale recovery, Settings launchers and Add-ons preferences.
  Evidence: `/tmp/wabi-embedded-polish-jj41SE`. Screenshot review included actual
  overview activity, People rejection, branding/payment mobile states and the
  forum with the preserved pinned panel. Forum styling is not signed off.
- Diff checks and the three updated skill validators passed. Generated protocol,
  postcard layouts, the minifier, native Tauri code and media ownership were not
  changed. No temporary test account was created on the live server.

Candidate SHA-256:
`45149c56c68dcb5c7cd2cf164e12b3d2f3df74ca7f75111439fc57965ff2b8ce`.
Logs: `/tmp/wabi-admin-{ui-unit,ux-check,tauri,static,server-final,wabidb-final,release-build,audio-final,workspace-browser-release,embedded-final}.log`.

The user subsequently authorized push, deployment and updating the native Wabi
repository in Wabi Lore. Delivery is a separate gate below; local acceptance
does not claim those external operations have already completed.
