# Showcase: coherent workspace navigation

Target: a community-showcase post, followed by an optional guided call and a
separate ordinary-account trial. This is showcase preparation, not launch
certification. No live account data or credentials belong in fixtures/media.

## Diagnosis and bounded objective

Wabi already has substantial communication and collaboration surfaces inside a
customizable, dockable shell. This pass makes that breadth discoverable and
reliably navigable; it does not add features or redesign the theme system.

The user-owned September 7 recon documents identified jumping navigation,
occluded targets and lost focus. Source tracing found the shared cause went
beyond styling: ChatHeader and MainLayout had different switch statements and
mount points. The latter omitted Project/Files and treated Whiteboard as
Messages. Chat's whiteboard precedence could also mask an addon. Full-height
workspaces were mounted below an extra bar without subtracting its height.

Headful baseline against an isolated real release server reproduced:

- Messages picker x=953.625; Planner picker x=376.15625 at 1440×900.
- Files selected from Planner remained Planner.
- Whiteboard selected from Planner showed Messages.
- Notes selected with Enter left focus on BODY.
- Notes y=50, height=900 in a 900px viewport.

Private disposable baseline evidence: `/tmp/wabi-workspace-baseline-dnCy7g`.
The existing four untracked recon documents are preserved, not rewritten.

## Implementation and tradeoffs

One persistent, labeled picker lives above the shell's changing center content.
It uses the existing icons, semantic theme tokens and Svelte 5 runes. Clicking,
tapping or keyboard activation reveals names and concise descriptions; no
hover-only discovery. The Messages return slot is reserved for layout stability.

`workspaceNavigation.ts` is the common resolver/transition boundary;
`workspaceNavigationState.ts` binds existing production stores and addon IDs.
No new persisted state. Explicit addon selection wins over remembered boards.
Returning selects the current channel once, clearing its board/voice view, and
preserves other open tabs and docked panels. Call media ownership is independent.
Obsolete duplicated voice open/close helpers are removed; the channel-change
voice-dashboard reset is retained and exercised through the new navigator.

Project/Files now render in the shell with their own full-height containers and
honest module-load errors. ChatHeader retains channel context, search, DM call
controls and Lore binding information. Ordinary workspaces remain inside the
customizable shell. No protocol, WabiDB schema, authorization or audio-transport
changes. Map selection is synchronous; the existing Map workspace hydrates its
own registry when mounted, so a delayed lookup cannot navigate back afterward.

| Location | Considered but rejected | Reason |
| --- | --- | --- |
| MainLayout / ChatHeader | Keep two mount points, change margins | Does not preserve focus or prevent routing drift |
| WorkspaceViewBar | Always-visible eleven-icon row | Does not fit a 360px center beside a pinned panel; scrolling alone still requires icon literacy |
| WorkspaceViewBar CSS | Shrink hidden pills to zero | Restores historical jumping/hover bugs |
| Navigation state | Third global view store | Duplicates the existing queue and board state |

Tradeoff: channel context now occupies its own row below the workspace picker.
The modest vertical cost buys one consistent navigation anchor across surfaces.

## Interface-skill review

Full review of the workspace picker and its shell integration, not the entire
frontend. Framework: Svelte 5; styling: existing plain CSS and semantic tokens.
The interface-polish skill shaped sizing, labels, focus, motion and theme review;
the frontend-architecture skill preserved existing workspace/docking ownership.
The skill-creator guidance was used for the narrow architecture-skill update.

| Category | Evidence inspected | Result |
| --- | --- | --- |
| Typography | Named destinations, current view, subordinate descriptions in dark/light screenshots | Clear within picker scope |
| Surfaces | Existing theme surfaces, border/shadow; bounded nonmodal picker at desktop and phone widths | Clear within picker scope |
| Animations | Hover geometry at 10% transition playback; reduced-motion near-zero global override | No moving/resizing targets; no entrance animation added |
| Icons | Existing currentColor artwork, decorative SVG accessibility attributes | Clear within picker scope |
| Performance | One mounted trigger; options/listeners only while open; Project/Files lazy import and failed-import test | Ownership checked; no performance profile claimed |

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| HIGH | `frontend/src/lib/workspaceNavigation.ts:16`, `workspaceNavigationState.ts:16`, MainLayout and ChatHeader handlers | Missing destinations and conflicting board precedence | Shared all-view transitions; call dashboard helpers consolidated | Requested view must actually open without changing media ownership |
| HIGH | `frontend/src/lib/components/WorkspaceViewBar.svelte:32` | Remount + unconditional blur; hover-only discovery | Persistent labeled trigger, explicit picker, focus return | Keyboard and touch usability |
| HIGH | `frontend/src/styles/components/main-layout-part1.css:51`, MainLayout workspace branches | Notes below viewport; Files/Project in message scroller | Height remaining below navigation; lazy errors retain return path | Workspace controls must stay reachable |
| MEDIUM | `WorkspaceViewBar.svelte:165`; obsolete rules in chat-header, chat-workspace, chat-mobile, mobile-shell and surfaces CSS | Oversized strip, width-changing hover, hidden targets | Center-bounded scrollable choices, ≥44px targets, reserved return slot | Works beside pinned panels and on narrow screens |
| MEDIUM | Architecture overview and frontend-architecture skill / compaction reference | Instructed agents to duplicate header routing | Current ownership and regression commands documented | Prevent reintroduction |
| HIGH — follow-up | `frontend/src/lib/components/chat/ChatComposer.svelte:58` | Draft and attachment state belongs to a composer instance destroyed by full-workspace switches | **Proposed, not implemented:** scoped draft lifecycle across workspace changes, including account/channel boundaries and active upload cancellation | Navigation must not silently discard unsent work; moving Project/Files into the shell exposes the same pre-existing full-workspace limitation |

## Verification

Executed locally (browser runs serialized with builds/checks):

```sh
cd frontend
bun run check
bun test src/lib
node scripts/workspace-browser-smoke.mjs
node scripts/audio-browser-smoke.mjs
bun run build:tauri
bun run build:static
```

- `bun run check`: **0 errors, 180 existing warnings in 48 files**; no new picker warnings.
- `bun test src/lib`: **452 passed, 12 skipped, 0 failed**. Includes 121 all-pairs
  workspace transitions and three boundary tests (external opens, retained tabs /
  other-channel boards, no current channel).
- Workspace browser smoke: **passed**, full headful app. Verified all eleven
  picker destinations, actual Planner/Files/Whiteboard/Project/Notes/Calls roots,
  trigger DOM identity/focus/anchor, Notes height, Enter/Tab/Escape/outside press,
  actual pinned People panel at 1000×800, 390×844 and 360×640 layouts, all option
  hit tests, touch-context taps, light theme, and failed Project module escape.
  Docking state is explicitly reset between pinned and mobile scenarios; this
  does **not** certify unpin/peek lifecycle during viewport changes.
- Audio browser smoke: **all 8 routes passed**. Extended the real call-panel
  harness to switch Planner/Files/Whiteboard/Calls/Messages while retaining three
  active call sessions, shared capture and transmit focus. Inputs remain synthetic;
  no real microphone/speaker, network peer, or native webview was exercised.
- Tauri frontend build: **passed**, including CodeMirror bundle. Static web build:
  **passed**, run last. No native packaging or new embedded Rust binary built.
- `git diff --check`: **passed**. Architecture skill validator: **passed**.

Private disposable screenshots: `/tmp/wabi-workspace-smoke-J6ZoHb` (dark/light,
pinned/narrow and hover review). Logs: `/tmp/wabi-workspace-{check,unit,browser,media,tauri,static}.log`.
No live credentials, data, commit, push, deployment or host package changes.

**Historical checkpoint verdict: Block until draft preservation is handled.**
The approved follow-through implements and tests draft ownership and recovery;
see [Full frontend polish](2026-09-08-full-frontend-polish.md) for current results
and remaining boundaries. The text below records this earlier checkpoint.
The bounded navigation/geometry checks pass; the newly identified draft lifecycle
is the next coherent objective, not a silently waived regression. Notes empty-state
copy and a populated demo walkthrough are subsequent polish. Not verified: draft
restoration, native Linux installer/runtime, physical Android, two-device audio,
live external Lore operations, production-served new bundle, full-app accessibility
or performance. No launch-readiness claim.

The workspace browser test uses full SvelteKit + a real isolated release
WabiDB/server, not a mock application. It needs an existing
`target/release/wabi-server`. Browser viewport checks are not physical Android
verification. Frontend Tauri compilation is not a native Linux installer build.
External Lore operations, live-user data, physical-device audio, and a public
showcase/demo dataset are outside this bounded navigation result. No push or
deployment is authorized by this new UX task.
