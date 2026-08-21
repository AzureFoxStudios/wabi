# Planner UX Analysis & Spruce-Up — 2026-08-21

Scope: frontend-only this pass (backend files are dirty from concurrent work; deploy gate stays explicit).
Author: Hermes (design calls) · Verified against tree at branch `wip/combined-handoff-2026-08-18`.

---

## 1. Root cause found: the sync engine points at routes that do not exist

`frontend/src/lib/business/sync.ts` pushes/pulls the whole snapshot to:

- `GET  /api/business/get`
- `POST /api/business/sync`
- socket event `business-data-updated`

**None of these exist in the Rust backend.** Verified:

- `core/crates/wabi-server/src/api/routes.rs` — no business nest/route.
- No `api/business.rs`; grep for `business_data|business-data-updated|business/get` across `core/crates` = zero hits.
- Full git history (`git log --all -S "business/get" -- core/`) — the backend **never had them**, in any branch or tag. The engine was written against the imagined API and shipped dead.

Worse: default mode is `'manual'` and **no UI anywhere calls `pullFromServer`/`pushToServer`/`triggerSync`** (grep over all `.svelte` = zero callers). The engine is unreachable even if the routes existed.

**Consequence:** every browser keeps its own private copy in `localStorage["business_data"]`. Moving `wabi.chat/business` → Planner didn't lose data — it surfaced that the data was *never shared*. Calendar-on-phone vs kanban-on-desktop are two different universes. That is the "not in sync" pain, exactly.

Within one browser, calendar and kanban DO share the same stores (`$todos` drive both the calendar's due-date pills and the board columns) — the desync is cross-device, not cross-view.

### Design call (this pass)

1. **Stop lying.** The header badge says "On this device" — good instinct, keep it, but make it *capability-aware*: probe `/api/business/get` once at sync-init; on 404 mark server sync unavailable and never retry-spam. When a future backend lands, the same probe flips the badge to "Synced" automatically.
2. **Give users a real escape hatch today:** Import/Export JSON in the Planner header menu (closes the long-open E3 gap). Cross-device transfer without backend work.
3. **Backend slice (deferred, designed here):** channel-scoped snapshot routes mirroring the wiki pattern — `GET/PUT /api/planner/{channel_id}/snapshot` storing the JSON blob in WDB per channel. Channels-as-roadmaps becomes literal: a Planner channel owns a roadmap collection; views stay personal. Not implemented this pass (core/crates dirty from concurrent session; deploy gate).

## 2. "Sign" is a mystery checkbox — overhaul to explicit Sign-offs

Current state (all five surfaces): a bare checkbox *"Sign this task/event/… with my username"* → sets `signedBy = username`, and for tasks/projects/sprints **silently flips `visibility` private↔public** (undocumented coupling). Display is a tiny `✍ name` in two places. No date, no multi-person, no undo, no explanation. Nobody can guess what it does or why.

### Design call

Reframe as **Sign-off** (approval/commitment), which is what the visibility flip reveals the original intent to be: "I stand behind this item publicly."

- **Data model:** add optional `signatures?: ItemSignature[]` to Todo/CalendarEvent/DiaryEntry/Project/Sprint in `shared/businessContracts.ts`. `ItemSignature = { by: string; name: string; at: number }`. Keep writing legacy `signedBy` (first signer's name) so older clients and existing snapshots stay readable. Additive, replay-safe.
- **Kill the hidden visibility coupling.** Signing no longer mutates visibility. (Behavior change, disclosed here.)
- **UI:** new `SignatureRow.svelte` — signed state shows chips (name + relative time, removable if it's yours); unsigned shows a quiet "+ Sign off" button. Replaces the checkbox in: KanbanTaskModal, CalendarEventModal, ProjectsView (project + sprint forms), DiaryView editor.
- **Display:** kanban cards get a `✍ N` badge; CalendarDayModal upgraded from lone name to chip list.

## 3. Views local, channels as roadmaps — the architecture answer

Ronin's ponder, made concrete:

| Layer | Home | Rationale |
|---|---|---|
| **View state** (active tab, month, column visibility, filters, panel width) | Device-local, always | UI is personal; nobody wants a teammate's scroll position. |
| **Content** (tasks, events, projects, entries) | Server, channel-scoped (target) | Team data outlives devices. Wiki already proves the pattern: `/api/wiki/{channel_id}/pages`. |
| **Roadmap mapping** | A Planner channel ≡ one roadmap | Board+Projects = the channel's roadmap; Calendar/Journal become per-user overlays on top. |

This pass ships the local half deliberately: `planner.activeView` persisted per device, board filters persisted, panel width already persisted. The server half is the deferred backend slice above.

## 4. Shell polish (Trello/Monday bar)

- Header overflow menu (`⋯`): Import, Export, Sync-status line (truthful).
- Stats pills become **controls, not decoration**: Overdue/Today/Week → open Tasks panel pre-filtered; Events → jump to Calendar. (Monday rule: every number answers "what do I do about it".)
- `Escape` closes the task/event modals (currently overlay-click only); title inputs autofocus.
- Active view survives remount (deep-link flow no longer resets you to Calendar).

## Task list (this pass)

- [x] Analysis doc (this file)
- [ ] Contracts: `ItemSignature` + `signatures[]` on 5 types
- [ ] `validation.ts`: signature sanitizer wired into all 5 sanitizers
- [ ] `SignatureRow.svelte` + wiring into 5 forms; kill visibility coupling
- [ ] Badges: kanban card ✍N, day-modal chips
- [ ] `sync.ts`: capability probe + `businessSyncAvailable` store; honest badge
- [ ] Header: overflow menu (Import/Export/status), persisted activeView, clickable stat pills
- [ ] Modal Escape + autofocus
- [ ] `bun run check` + STATIC_BUILD build green
- [ ] Skill update + path-scoped commit

## Explicitly NOT done here (deferred scope)

- Backend `/api/planner/{channel_id}/snapshot` routes (design in §1.3; core/crates has concurrent WIP).
- Per-user overlay filtering (calendar/journal scoping) — needs the server slice first.
- GanttChart/Sprint burndown revival — separate pass.
- Mobile-specific planner layout — separate pass.
