# Wabi UI/UX recon — verified findings and coverage

Status: reconnaissance complete for the agreed first pass. No frontend implementation authorized in this turn; no fixes applied.

## Evidence and provenance

- Local source inspected: `/var/home/Ronin/wabi`, `main`, `a362c75e`.
- Real website: `https://wabi.chat/`, owner account approved by user. This is a development site, not production. No accounts created, messages sent, uploads made, calls joined, preferences deliberately changed, or data reset.
- Live owner theme: Joker. Owner/navigation state persisted normally during browsing. Isolated browser contexts were closed after probes.
- Live entry asset: `start.CQh3G83y.js`; main stylesheet: `0.NxCkIeQX.css`. Existing local build entry: `start.BZqpxkZ1.js`. They differ; do not claim local source and the live binary are the same build. Source trace points were checked independently against the observed behavior.
- `bun run check`: exit 0, 0 errors, 185 warnings in 50 files. No build or test-suite run during recon.
- Read-only OpenCode scout: `opencode/nemotron-3-ultra-free`, session `ses_f859ffa2ffferwVn27oi6PevG7`; smoke and scout completed; OpenCode reported cost 0. Actual log: 23 distinct source reads, only its report written. Parent rejected multiple unsupported claims; see the corrections at the top of `2026-09-07-ui-recon-source-scout.md`.
- Durable local evidence: `/var/home/Ronin/wabi-backups/ui-recon-20260907-123737/evidence/`. Contains `walk.jsonl`, `focused.jsonl`, `final-probes.jsonl`, inventories, coverage summary, typecheck log, scout log and credential-free probe scripts. DOM text may contain existing test conversations; do not publish raw evidence. Screenshots are captured artifacts, not a claimed pixel-by-pixel design review.
- Browser-harness tabs disappeared during the first survey. Switched to installed Playwright with isolated full Chromium; no browser packages installed. Main walkthrough completed with 27 records and no observed pageerror events. A later focused script timed out after selecting a DM and trying to locate a channel toolbar; this is recorded as a harness/navigation limitation, not an app crash. A fresh targeted probe completed successfully.

## Verified issue ledger

All items below remain OPEN. P1 = repair first; P2 = next batch. Observed behavior is not the same as a fully proven root cause.

### UI-01 — Folder expand/collapse symbols are invisible (P1)

Reproduction: owner login → expanded channel folders at 1440×900. Inspect `.category-chevron` and its SVG.

Observed: both measured 0×0; SVG computed stroke is `none`. Folder icon/text remain visible, but the direction/expanded indicator is missing.

Source: `frontend/src/lib/components/ChannelSidebar.svelte:1168`; `frontend/src/styles/components/sidebar-channels.css:1078-1085`. The chevron markup has neither explicit dimensions nor stroke; wrapper lacks a fixed box.

Direction: give the shared chevron a non-shrinking size and explicit stroke/currentColor; preserve rotation and aria-expanded.

Acceptance: open/closed folder chevrons visibly differ; stable box in full and compact widths; no row-height shift; keyboard toggle works. Verify dark and contrasting theme.

Evidence: `focused.jsonl`, name `category-chevron`; `walk.jsonl` zeroIcons.

### UI-02 — Workspace navigation changes position between views (P1)

Reproduction: Messages → Planner → Whiteboard → Notes, without changing dock or window size.

Observed at 1440×900: bar starts at x590 inside the chat header, x280 for Planner, and approximately x491 for Whiteboard. The return button similarly moves between header layouts. This is unrelated to user-selected left/right docking.

Source: `components/chat/ChatHeader.svelte:145-148` mounts the bar in header actions. `components/MainLayout.svelte:1167-1170` mounts it directly for several addon/voice surfaces. `components/WorkspaceViewBar.svelte:48-59`; `styles/components/surfaces.css:9-15`.

Direction: one center-pane header contract for channel and addon workspaces: consistent context/title, workspace switcher anchor and return location. Preserve sidebars and current channel. Do not solve it by removing workspaces or forcibly changing dock preferences.

Acceptance: all 11 current entry points keep switcher/return at the same intended anchor, including long channel names; switching does not teleport controls or unexpectedly change the conversation.

Evidence: `focused.jsonl`, names `header-messages`, `header-planner`, `header-whiteboard`.

### UI-03 — Workspace toolbar exceeds available width (P1)

Reproduction: owner layout with left channel sidebar and pinned People panel, viewport 1000×800 → reveal workspace toolbar by mouse.

Observed: central chat is 360px wide; revealed toolbar is 408px wide. The Map control is visible by style but its center fails hit-testing (`hit:false`). Its x-position is 651 while the central pane ends at 640. Other surfaces occupy the area it extends into.

Source: same shared bar/header files as UI-02; `styles/components/chat-workspace.css:29-83`, `styles/components/chat-header.css:139-166`; container sizing in `styles/components/main-layout-part1.css`.

Direction: explicit responsive overflow/menu behavior based on available center-pane width, not just viewport width. Keep the selected view and view-switch affordance reachable. Reserve space rather than squeezing the user's pinned panel or removing resizing.

Acceptance: every view is reachable with real pointer and keyboard input at narrow widths; no control paints into/under the contextual panel; mobile has an explicit discoverable switcher.

Evidence: `final-probes.jsonl`, name `narrow-toolbar`; `walk.jsonl`, step `narrow-desktop`.

### UI-04 — Settings opens without moving focus; immediate Escape fails (P1)

Reproduction: click User Settings, then press Escape without first clicking inside the dialog.

Observed: active element remains the sidebar User Settings button outside the dialog; the dialog remains open after Escape.

Source: `components/Settings.svelte:272-295`. Escape listeners are on overlay/dialog while focus remains outside. Role/aria-modal/tabindex are present but do not transfer or contain focus by themselves.

Direction: use the existing accessible modal mechanism if compatible; set initial focus, contain Tab/Shift+Tab, close consistently on Escape, restore trigger focus. No account/security handler changes.

Acceptance: immediate Escape closes; keyboard cannot tab into background; close restores focus; controls retain visible focus.

Evidence: `final-probes.jsonl`, names `settings-initial-focus`, `settings-escape`.

### UI-05 — Keyboard workspace activation loses focus (P1)

Reproduction: focus Open Planner and press Enter.

Observed: Planner opens, but focus becomes BODY rather than staying on a meaningful navigation/content target.

Source: `components/WorkspaceViewBar.svelte:36-42` unconditionally blurs for every click event, including keyboard-generated activation. The comment describes mouse behavior but code does not discriminate input modality.

Direction: preserve keyboard focus while retaining the deliberate mouse-hover collapse behavior. Align tab semantics with the actual interaction pattern; do not add ARIA roles without corresponding keyboard behavior.

Acceptance: Enter/Space changes workspace with visible, predictable focus; subsequent Tab progresses logically; mouse selection/alt-tab does not leave unwanted hover expansion.

Evidence: `final-probes.jsonl`, name `keyboard-workspace-activation`.

### UI-06 — Storage exposes translation keys and misleading retention copy (P1)

Reproduction: Settings → Storage.

Observed: visible `offline.title`, `offline.subtitle`, `offline.wabiDB.*`, and `offline.scopes.*`. Subtitle says the server stores nothing permanently.

Source: `components/StorageSettings.svelte:393-440` requests root `offline.*` keys. Both locales define these beneath `storage.offline.*` in `lib/i18n/locales/en.json` and `es.json`. Programmatic lookup confirmed root keys missing and nested keys present. `en.json:529` contains the blanket retention claim; documented architecture supports explicit forever retention (`docs/architecture/overview.md:99-102`).

Direction: repair the namespace consistently, test used translation keys, and explain device cache versus server/channel retention without claiming universal non-persistence. Coordinate retention wording with security lane; do not alter policy or storage behavior.

Acceptance: no raw keys in English or Spanish; local-cache controls clearly identify their scope; copy does not promise deletion/non-persistence the system cannot universally guarantee.

Evidence: browser-harness `settings-tab/Storage` row plus main `walk.jsonl`; source lookup recorded during recon.

### UI-07 — Notes exceeds its host height and repeats its empty message (P2)

Reproduction: Open Notes with an empty local notebook at 1440×900.

Observed: `.notes-workspace` begins at y50 but is 900px tall, below a separate 50px view bar. Its resizer also spans 900px. Intro text appears twice and no visible Notes title identifies the surface.

Source: `components/MainLayout.svelte` standalone workspace mount; `components/KeepNotesView.svelte`; `components/NotesWorkspace.svelte:312,380-395`; `styles/components/main-layout-part1.css:49-52`. The parent allocation/100% height is a likely shared root, requiring verification for other standalone workspaces too.

Direction: allocate remaining height below the common header, not full host height; keep internal scroll; one clear Notes identity, empty explanation and creation action rather than duplicate copy.

Acceptance: notebook/resizer/editor stay inside available height; bottom content reachable; one clear first-note action; compact dock unaffected.

Evidence: `focused.jsonl`, name `notes-sizing`; `walk.jsonl` Open Notes.

### UI-08 — Audio switches lack accessible names/state (P1)

Reproduction: Settings → Audio and Video → inspect Sound Effects, Microphone, Camera and spatial controls.

Observed: toggles are button elements with no aria-label/labelledby/pressed/checked semantics. Several are empty buttons styled as switches; text in an adjacent span does not label the button automatically. This is not proof the CSS switch artwork is missing.

Source: `components/settings/AudioSettingsTab.svelte:197-237`.

Direction: consistent labeled switch semantics and state feedback using existing UI primitives. Keep all mic/camera/transport/device handlers unchanged; coordinate file ownership with concurrent audio/security work before editing.

Acceptance: accessibility tree exposes descriptive name, role and on/off state; keyboard toggling works; existing audio behavior unchanged.

Evidence: `focused.jsonl`, name `audio-controls` (numeric fields are the inspected button array).

### UI-09 — Existing DM row has no recognizable recipient (P2, observed anomaly)

Reproduction: Messages hub → the existing Unknown row → open it.

Observed: list says Unknown / No messages yet; opening shows generic Direct Message with no recipient identity. No message was sent. Could be stale/deleted-user data, participant resolution or a partial server payload; root cause NOT established.

Source trace point: `components/DmHub.svelte:66-83`, `resolveDmOtherUser` and its input data. Coordinate any auth/member/API changes with security lane.

Direction: inspect the exact record and distinguish deleted/unavailable recipient from loading or failed identity resolution. Provide an honest fallback and recovery action, not guessed identity or silent deletion.

Acceptance: existing valid DMs resolve participants; deleted/unavailable contacts are clearly labeled; opening a row preserves recipient context.

Evidence: `walk.jsonl` messages-hub; `focused.jsonl` unknown-dm.

### UI-10 — Admin Roles section is empty for the owner while stats report 2 roles (P1)

Reproduction: Settings → Admin → Dashboard → Roles (owner, 1440×900).

Observed: section shows only the "Role Names" heading, no role rows or inputs. In the same session the socket emitted `role-definitions-updated` with `{"roles":[]}` four times, while `GET /api/admin/stats` (HTTP 200) reports `totalRoles: 2` and `roleDistribution: Member 4 / Owner 1`.

Source trace: `components/AdminWorkspace.svelte:637-658` (emits `get-role-definitions`, renders `RoleNamesPanel` from `roleDefinitions`); `components/admin/RoleNamesPanel.svelte:22-28` (renders nothing when the array is empty, no empty-state); `core/crates/wabi-server/src/socketio/wiring_handlers.rs:67` (`list_role_definitions("default-workspace")`). Root cause NOT established — two role sources disagree; do not edit the backend from this lane.

Direction: reconcile the role-definition source with the stats source (or explain the difference), and give the section an explicit empty/error state instead of a bare heading. Coordinate with the security lane before touching role APIs.

Acceptance: owner sees the 2 roles with editable labels, or a clear statement of why none are listed; no silent blank section.

Evidence: `evidence/admin-stubs/admin-states.jsonl` (Roles row), `role-frames.json`, `api.json`.

### UI-11 — Role distribution counts render glued to percents (P2)

Reproduction: Admin → Overview → Role Distribution.

Observed: text extraction reads "480%" and "120%". Source (`components/admin/OverviewSection.svelte:217-218`) emits `{r.count}<span class="admin-role-bar-pct"> {pct}%</span>` — the space exists in markup, so the visible gap depends on `.admin-role-bar-pct` styling (`styles/components/admin-center-stage.css:612`). Percentages themselves are correct per-role shares (4/5, 1/5), not a math error.

Direction: give the count/pct pair an explicit gap so it reads "4 · 80%" at all widths.

Acceptance: count and percent are visually distinct; bar widths still match the labeled share.

Evidence: `evidence/admin-stubs/admin-states.jsonl` (overview-settled roles array).

### UI-12 — Role Gates emoji selector lists 4,335 raw asset IDs (P2)

Reproduction: Admin → Role Gates → Emoji Role Automation → Select emoji.

Observed: the dropdown contains 4,335 options labeled `openmoji_0023-FE0F-20E3`, `openmoji_002A-FE0F-20E3`, … — internal asset IDs, not human names. The role and message selects each expose a single option with no guidance.

Source: `components/admin/EmojiRoleRulesPanel.svelte:51-56` renders `emoji.name` from the `$emojis` store; the store's names are raw OpenMoji IDs.

Direction: human-facing aliases/search for emoji options (known pattern — see frontend architecture notes on emoji search), plus a searchable/paginated control instead of a 4k native select. Keep rule create/delete behavior unchanged.

Acceptance: an admin can find an emoji by typing what it looks like; the list stays responsive; dependent selects explain what to pick first.

Evidence: `evidence/admin-stubs/admin-states.jsonl` (Role Gates selects).

### UI-13 — Admin content overflows horizontally on narrow viewports (P2)

Reproduction: Admin dashboard at 390×844 → Role Gates, Server Policy.

Observed: Role Gates content measures 599px wide inside a 186px container (3.2× overflow; emoji-rule row selects up to 589px). Server Policy scrolls vertically to 2,193px (expected for a long form; the horizontal axis is the defect).

Source: `components/admin/EmojiRoleRulesPanel.svelte` flex-wrap row with fixed-width selects; `styles/components/admin-center-stage.css:889-906` mobile rules narrow the sidebar but do not constrain the rule row.

Direction: constrain the rule row and selects to the container (wrap/stack under ~560px); keep desktop layout untouched.

Acceptance: no horizontal scrolling on Role Gates or Server Policy at 390px; all controls reachable by touch/keyboard.

Evidence: `evidence/admin-stubs/admin-states.jsonl` (role-gates-mobile, policy-mobile geometry).

### UI-14 — Dashboard Back lands in Settings Profile, not chat (P1)

Reproduction: Settings → Admin → Dashboard → Back (without closing Settings first).

Observed: Back returns to the Settings dialog on the Profile tab — not the Admin tab it launched from, and not chat. A second dismiss is needed to reach the conversation.

Source trace: `components/AdminCenterStage.svelte:103-105` (`goBackToChat` sets `centerPanelView` only); Settings open state lives separately in `MainLayout.svelte:69` (`showSettings`), which stays open underneath the fullscreen dashboard.

Direction: decide one contract — either close Settings when the dashboard opens, or return Back to the Admin tab — and keep it consistent. No auth/session changes.

Acceptance: Back produces exactly one predictable surface (chat, or the launching Admin tab); no surprise Profile tab; focus lands somewhere sensible.

Evidence: `evidence/admin-stubs/admin-states.jsonl` (back-result, settings-dismissed).

### UI-15 — Stub drawer ignores keyboard and overflows short windows (P2)

Reproduction: click "Add or manage panels" → press ArrowDown; and open the drawer in a 360px-tall window.

Observed: focus stays on the Add button (ArrowDown moves nothing; the drawer root has `tabindex="-1"` but is never focused), though Escape closes correctly. In a 360px-tall window the 362px drawer starts at y24 and runs 26px below the fold. All drawer items themselves are hit-testable at desktop and narrow widths.

Source: `components/RightStubStrip.svelte:281-290` (drawer markup, no focus call — contrast the context menu, which focuses its first item at lines 46-51); `RightStubStrip.svelte:140-147` (`positionDrawer` clamps top but not height); `RightStubStrip.css` list `max-height: 320px`.

Direction: mirror the context-menu focus pattern for the drawer (focus first item, ArrowUp/Down move, Escape closes and restores focus); clamp drawer height to the viewport.

Acceptance: keyboard-only user can open, browse, add, and dismiss the drawer; drawer never extends below the fold.

Evidence: `evidence/admin-stubs/toggle-probes.jsonl` (drawer-focused, drawer-arrowdown), `evidence/admin-stubs/stubs-walk.jsonl` (drawer-short-window).

### UI-16 — Pinned-panel restore after reload: INCONCLUSIVE, needs re-probe (open question)

Observed: after pinning Notes and reloading with a 2s settle, the panel showed mode `none` with empty content, while both localStorage slots still recorded `activePanelId: users` — the pin never reached persisted state. The settle may simply have preceded boot restore, so this is NOT filed as a bug.

Re-probe: pin Notes → wait for the debounced `PUT /api/user/layout` → reload → wait for `layoutLoaded` (not a fixed timeout) → compare. Do not "fix" persistence until that probe lands.

Evidence: `evidence/admin-stubs/stubs-deep-states.jsonl` (initial → notes-pinned → reload-settled), `after-remote.json`.

## Stub + panel behaviors verified working (no repair proposed)

- Hover/focus on a stub peeks that panel while a pinned panel stays committed; leaving restores the pinned panel; moving onto the peeked panel keeps it (150ms shared dismiss timer). Click a stub pins it; clicking the active stub closes the panel entirely (zone unmounts); clicking again re-pins. Toggle probe: People pinned → closed → re-pinned cleanly.
- Drag-resize works both directions (360 → 443 → 358 zone width) via the window-listener wiring.
- Stub side switch moves the whole zone (x1080 right ↔ x0 left) and back without drift.
- Drawer lists 8 available panels (Calls, Layers, Map, Media, Xfers, Project, Tasks, Admin); each opens, pins, and removes cleanly; strip returns to the People/Messages/Notes default. Context menu (Remove/Move up/Move down) and Escape both work.
- Overlap probe over the pinned People panel found zero stub-covered controls.

Side-effect disclosure: these probes exercised the app's normal auto-persist, issuing `PUT /api/user/layout` (login POST plus layout PUTs only — see `writes.json`). Final owner layout was restored to People pinned, right side, ~360px width, default stubs. No messages, uploads, calls, or admin mutations were made.

## Design opportunities, not yet proven defects

- Layout settings expose Nav dock, Server rail side, Conversation layout, Collapse nav and presets with overlapping wording. Clarify what each controls; use simple preview/grouping. Do not delete flexibility before testing combinations.
- Contextual panel stubs sit over the panel's outer edge in the current implementation. Review obstruction and discoverability with real hit tests; source comments explicitly describe this arrangement, so it is not automatically a regression.
- Audio settings mix everyday choices with transport diagnostics and host limitations; Admin is a long stack of unrelated forms; Add-ons displays implementation-oriented terms. Apply progressive disclosure and clearer group hierarchy after behavior fixes.
- Notes/Reader/Map empty states repeat actions or copy across side and center regions. Prefer one coherent invitation when empty while retaining useful toolbar actions after content exists.
- Notification permission text and the stored enabled preference can disagree (permission not yet requested versus Enabled). Distinguish requested preference, browser permission and actual subscription state.
- Mobile probe here is narrow-viewport desktop Chromium, not an actual touch/PWA/native test. Do not infer touch usability from that result.

## Coverage — entry reconnaissance, not exhaustive feature QA

Recorded 11/11 discovered workspace buttons and 11/11 non-logout settings tabs; counts checked programmatically against inventories. Normal app walkthrough observed no pageerror events. This does NOT prove all functions work.

Workspace entries (all mounted and returned via Messages in the scripted walkthrough):
- [x] Voice — empty/no-active-call state; no joining, mic or recording.
- [x] Messages — existing conversation and composer; no sends, edits or deletes.
- [x] Whiteboard — shell/toolbar; no drawing or collaboration.
- [x] Planner — Calendar landing; other inner tabs/data flows not exercised.
- [x] Notes — empty view; no notes created.
- [x] Project/Lore — repo overview; inner Files/History/Review not exercised.
- [x] Files — existing folder/empty preview; no upload/download.
- [x] Media — empty album state; no creation.
- [x] Reader — empty state; no file import or document layout.
- [x] 3D — empty state; no model loaded.
- [x] Map — empty state; no places created or location permission requested.

Settings tabs (all opened/read without changing values):
- [x] Profile
- [x] Audio and Video
- [x] Notifications
- [x] Accessibility
- [x] Appearance
- [x] Server
- [x] Add-ons
- [x] Emojis
- [x] Storage
- [x] Admin
- [x] About

Other evidence: login/startup, channel/folder shell, existing DM anomaly, 1440×900 → 1000×800 → 390×844 → desktop restoration, focused keyboard activation/Settings Escape.

Still needed during repair verification: actual touch and PWA, alternative themes/reduced motion, full keyboard/focus loop, user-selected dock/preset combinations, real drag resizing, channel switches from active DMs, all contextual menus/dialogs, long content, backend error/reconnect states, non-owner/guest gating, workspace inner flows. No claims made for those.

## Implementation sequence after approval

1. Batch A — recognizable controls and reliable input: UI-01, UI-04, UI-05, UI-06. Small source-local fixes plus focused regression probes. UI-08 can be a separate file-bounded task once ownership is clear.
2. Batch B — stable workspace shell: UI-02 + UI-03 + UI-07 height allocation. These are related: fix the shared header/remaining-space contract once, verify every workspace, do not pile on independent CSS overrides.
3. Batch C — identity and settings clarity: investigate UI-09; labels, grouping, switch consistency, clear local/server scope and feedback; improve Notes empty state.
4. Batch D — remaining surface/taste pass: messages/composer, sidebar and panel chrome, dialogs, workspace inner views, theme/mobile/touch. Use the unchecked coverage list, not another broad source crawl.

Verification at each batch boundary: focused behavioral browser test, `bun run check` compared to the current baseline, `bun test src/lib` with its own first-run baseline, `bun run build:static`, then candidate-build browser proof. No failed gate may be called fixed merely because it was pre-existing. Keep backend/security findings in their own lane. Push/deploy remains a separate explicit gate.

For free-worker handoff: give ONE batch, exact allowed paths, these reproductions, reserved security paths, no installs/model switching, and the named acceptance tests. Parent verifies actual diff and browser behavior. Never dispatch the original scout's rejected repair list.
