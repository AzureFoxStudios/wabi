# Wabi frontend UI/UX cleanup plan

Status: RECON COMPLETE; implementation approved 2026-09-08, including parallel subagents. Current execution/results: [Full frontend polish](2026-09-08-full-frontend-polish.md). The recon-only permissions and pause below describe the historical scouting turn, not the newly approved work.
Owner: frontend polish session. Separate Astra session owns security.

User-approved access: owner account on `https://wabi.chat/`; this is a disposable development site, not production. Credentials are intentionally omitted. Do not reset the site during recon. Read-only OpenCode assistance is approved; frontend edits, commits, and deployment are not part of this turn.

## Recon result and first implementation batches

Verified issue ledger: `docs/plans/2026-09-07-ui-recon-findings.md`. This is the evidence source for the priorities below; the source scout report contains rejected claims and is NOT an execution plan.

- Batch A: repair invisible folder chevrons, Settings initial focus/Escape, keyboard workspace focus, and Storage translations/retention wording. Label audio switches in a separately owned presentation-only task.
- Batch B: one stable workspace header and available-height contract; stop navigation jumping between header/left edge, keep all views reachable in a narrow center pane, fix Notes extending beneath the viewport.
- Batch C: resolve the Unknown DM anomaly; clarify settings hierarchy, local/server scope and empty states.
- Batch D: admin + stubs — empty Roles section (UI-10, needs backend coordination), dashboard Back contract (UI-14), role-gates selector usability + mobile overflow (UI-12, UI-13), drawer keyboard/viewport clamp (UI-15), count/percent spacing (UI-11). Re-probe pin-restore (UI-16) before any persistence change.
- Batch E: remaining message/sidebar/overlay/workspace taste and touch/theme checks from the explicit coverage gaps.

Preserve real docking/customization. No broad token sweep, icon-library swap, feature deletion or forced narrow panels. No source edits, commits, resets, build, push or deployment in this recon turn.

## Goal

Make Wabi visually coherent and predictable to use: visible, recognizable controls; stable placement; understandable navigation; readable content; useful feedback. This is not a token-renaming exercise or a wholesale redesign by default. Existing structure and historical skills are evidence, not design law.

## Verified starting point

- Repository: `/var/home/Ronin/wabi`, branch `main`; clean at initial inspection, HEAD `a362c75e`.
- Frontend: Svelte/SvelteKit with existing plain-CSS tokens and shared components. Keep that stack; do not import React/Tailwind conventions from generic UI skills.
- Stylesheet entry: `frontend/src/routes/+layout.svelte` imports `frontend/src/styles/styles.css`. Old notes referring to `frontend/src/styles.css` are stale.
- Navigation dock and contextual-panel side are separate state paths: `layoutStoreNav.ts`, `layoutStoreStates.ts`, `layoutStoreRightPanel.ts`, with workspace restoration in `layoutStoreUtils.ts`. Right-docked navigation deliberately has some reversed CSS. This is a trace target, NOT proof that every reversal is a bug.
- Icons use inline SVG, shared renderers such as `WorkspacePanelIcon.svelte`, and some Unicode/emoji. Diagnose actual missing glyphs before replacing the icon system.
- Owner-authenticated `https://wabi.chat/` inspected: 11/11 workspace entry buttons, 11/11 settings tabs, DM hub, and desktop/narrow/mobile-size shells. This is entry-state reconnaissance, not exhaustive feature QA. Live theme Joker.
- Live entry `start.CQh3G83y.js` differs from existing local build entry `start.BZqpxkZ1.js`; public assets are NOT proof of local HEAD. Main walkthrough recorded no pageerror events. Full coverage/limits are in the findings ledger.
- No listeners on local ports 5173 or 3001 at initial inspection. No local app was started.
- `bun run check` completed: 0 errors, 185 warnings in 50 files. Tests and static build were not run for recon.
- Read-only OpenCode Nemotron scout completed; reported cost 0. Parent verified only its report was written and corrected unsupported findings.
- Evidence and credential-free probe scripts: `/var/home/Ronin/wabi-backups/ui-recon-20260907-123737/evidence/`.

## Scope and coordination

Allowed: frontend presentation, navigation/interaction behavior, accessibility, associated frontend tests, and this plan/evidence ledger. Review all reachable frontend surfaces, including feature workspaces; prioritize repair rather than silently omitting difficult screens.

Reserved for the security session: backend, authentication/authorization policy, session/token handling, sanitization, encryption, API contracts, dependency security changes, and security-sensitive frontend handlers. Audio/calling transport and database behavior are not polish work. Audit visible call controls without rewriting their media engine.

Before editing, re-read git status and establish exact file ownership. A frontend path is not automatically safe if the security session is editing it. Record a concrete cross-lane issue and coordinate rather than modifying the same code concurrently. No reset, checkout, stash, broad staging, account creation, test-data purge, or production changes to make a screenshot easier. Commit only verified, path-scoped work; push/deploy require explicit authorization.

## Budget discipline

- One bounded discovery pass, then concrete repair batches. No exhaustive file reading before producing useful work.
- Use searches and scripts for inventories and repeated checks; retain compact evidence on disk instead of dumping whole files into context.
- No parallel paid Astra review swarm. Consider a single available lower-cost implementation worker only for a well-defined batch; do not switch models or assume credits are available.
- Reuse existing components and tests. No new icon/design framework or dependency by default.
- Fix common causes once, then verify their consumers. Avoid repeated full builds for individual spacing edits; run the full gate at coherent batch boundaries.
- Stop at reviewable batch boundaries and report completed versus open work. This session cannot guarantee a dollar cap without reliable usage/balance telemetry.

## Task 1 — Establish a reproducible walkthrough

- [x] Confirm instance and approved owner access without creating an account.
- [x] Record source/live asset identity, theme, viewport, observed layout and account role separately.
- [x] Run `bun run check` once; measured baseline recorded above.
- [x] Use the real wabi.chat backend for the walkthrough; no mocked responses.
- [x] Record UI-01 through UI-09 in the findings ledger with reproductions, source trace points and acceptance gates.
- [x] Follow-up: full Admin dashboard (8/8 sections), stub hover/click/pin/drag/side/drawer/menu behaviors — UI-10 through UI-16 plus verified-working stub notes in the findings ledger.

Gate: the main interface is reachable, evidence provenance is explicit, and there is a usable reproduction for the first repair batch.

## Task 2 — Walk the whole interface once

First-pass entry coverage is complete and enumerated in the findings ledger. The broader checkboxes below stay OPEN because the requested deeper states/flows were not all tested. For each surface, inspect normal, hover/focus, selected, loading, empty/error, and narrow-screen states where applicable. Record inaccessible surfaces as BLOCKED rather than passed.

- [ ] Entry: launch/login, guest prompts, server selection, reconnect/loading and first-visible state.
- [ ] App shell: server rail, channel/folder list, user card, header/view bar, contextual-panel strip, resizing/collapse/reopen, menus and popouts.
- [ ] Conversations: channel and DM list/thread, unread/selected state, message grouping, composer, replies, reactions, attachments, search, edit/delete prompts.
- [ ] Settings: every available tab and control, not only the outer modal; profile, appearance, layout, notifications, audio, storage, addons and host/admin options as exposed by the current app.
- [ ] Workspaces: Notes, Planner, Files/Media, Reader, Whiteboard, Map/3D, Lore/Code, and any other registered surface. Verify entry, orientation, action feedback and return path.
- [ ] Calls: visible join/leave/mute/device/share controls, status and errors; keep transport changes out of this lane.
- [ ] Shared overlays: dialogs, confirmations, command palette, tooltips, toasts, selection menus, focus restoration and Escape behavior.
- [ ] Responsive/accessibility pass: desktop, narrow desktop and mobile; keyboard-only; reduced motion; default dark and a contrasting theme. Exercise saved layout choices and refresh/resize transitions.

Gate: every discovered surface has an audit status, and findings distinguish reproduced defects, source-only suspicions and design recommendations.

## Task 3 — Repair missing or misleading controls first

Initial trace points:
- `frontend/src/lib/components/WorkspacePanelIcon.svelte`
- `frontend/src/lib/components/WorkspaceViewBar.svelte`
- `frontend/src/lib/components/settings/SettingsTabIcon.svelte`
- `frontend/src/lib/components/message/MessageItemActions.svelte`
- `frontend/src/lib/components/sidebar/ProfileCard.svelte`
- `frontend/src/lib/unicodeEmojis.ts`, `unicodeEmojisCore.ts`
- Actual consuming CSS under `frontend/src/styles/components/`

- [ ] For each reproduced missing symbol, distinguish missing asset/path from zero sizing, inherited color, clipping, opacity/hover gating, font support or failed mapping.
- [ ] Repair the shared cause with explicit icon dimensions, legible theme-aware color and a meaningful fallback where appropriate.
- [ ] Make icon meaning consistent across surfaces. Give icon-only controls accessible names, useful tooltips and visible hover/focus/selected states.
- [ ] Confirm touch access does not depend on hover. Preserve legitimate disabled/permission states rather than weakening gates.

Gate: affected controls visibly render and remain understandable in their real states and selected theme samples. Use the existing `bun run check:unicode-emojis` when emoji handling changes; SVG rendering still requires browser checks.

## Task 4 — Stop unexplained movement and layout breakage

Initial trace points:
- `frontend/src/lib/components/MainLayout.svelte`, `ChannelSidebar.svelte`, `ServerRail.svelte`
- `frontend/src/lib/layoutStoreNav.ts`, `layoutStoreStates.ts`, `layoutStoreRightPanel.ts`, `layoutStoreUtils.ts`
- `frontend/src/styles/components/sidebar-core-part1.css` and subsequent imported overrides
- `frontend/src/lib/rightPanelStubStrip.test.ts`, `frontend/src/lib/docking/layoutSchema.test.ts`

- [ ] Reproduce the exact transition: channel/workspace switch, refresh, collapse, drag, popout, breakpoint or layout-setting change.
- [ ] Trace which state or CSS rule actually controls placement, including persisted preferences and workspace restoration.
- [ ] Preserve deliberate user-selected docking; remove incidental moves, stale restores, contradictory placement rules and detached menu anchors.
- [ ] Keep resizing functional. Fix content overflow/min-size constraints rather than making panels permanently narrower.
- [ ] Normalize action placement where inconsistency has no useful meaning. For a substantial structural change, show a concise proposed arrangement and rationale before implementation.

Gate: controls stay on the expected side through tested transitions; menus follow their triggers; saved choices survive refresh; keyboard/DOM order is sensible. Add targeted transition regressions, not only screenshots.

## Task 5 — Improve daily flows and visual hierarchy

Initial trace points: `components/chat/ChatHeader.svelte`, `WorkspaceViewBar.svelte`, relevant message/sidebar components, `Settings.svelte`, `components/settings/`, and the verified shared stylesheet/token entry.

- [ ] Clarify where the user is, what the primary action is and how to return. Remove confirmed duplicate/dead entry points, not working features.
- [ ] Stabilize channel/DM/workspace switching without unexpectedly resetting context or covering the whole shell.
- [ ] Improve typography, spacing, density, alignment, truncation, contrast and scroll behavior on the actual screens.
- [ ] Review settings grouping, labels, dependencies, save feedback and destructive-action separation control by control.
- [ ] Provide actionable empty/error states and non-jumping loading feedback.
- [ ] Make dialogs and menus predictable: dismissal, focus trap/return, stacking and viewport containment.
- [ ] Preserve Wabi's theming and ambient personality; do not impose a generic monochrome redesign or erase customization to satisfy a skill checklist.

Gate: each changed surface has an observable usability or visual improvement, not merely tidier CSS. Structural simplification remains allowed when it improves the task flow.

## Task 6 — Verify and close each repair batch

- [ ] Review the exact diff against the starting baseline and peer ownership; remove unrelated changes from this batch, never from the peer's worktree.
- [ ] Run focused regression tests, then `bun run check` and `bun test src/lib` from `frontend/`.
- [ ] Run `bun run build:static` at the batch boundary. Do not use the adapter-node default for the Rust-embedded app.
- [ ] Render affected screens against the candidate build; inspect computed styles and before/after evidence. Verify real interactions, not merely that a component mounts.
- [ ] Repeat the affected path at narrow/mobile sizes, with keyboard navigation, and relevant theme/docking variants.
- [ ] Record failures and blockers honestly. No authenticated-UI claim from login-only checks; no live-deploy claim from a local build.
- [ ] Commit the tested, exact paths and update the issue ledger. Deploy only on explicit authorization, then verify the served build and affected UI again.

## Priority and next decision

NOW: review the evidence-based attack order; implementation remains paused as requested.
NEXT after approval: Batch A, then shared-shell Batch B, each with scoped files and real browser acceptance tests.
LATER: Batch C/D and documented coverage gaps; larger redesign only where findings justify it.

Recon and baseline typecheck are complete. No UI fixes, test-suite run, static build, commit, push or deployment are claimed.
