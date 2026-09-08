# Full frontend polish — 2026-09-08

Status: documented repair pass implemented and verified. The user subsequently
authorized push and deployment; release progress is recorded below. No native
installer or real-device test is claimed by this pass.

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
