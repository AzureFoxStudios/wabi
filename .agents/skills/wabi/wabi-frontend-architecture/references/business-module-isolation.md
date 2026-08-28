# Business Module Isolation — /business

## Surface topology

- Route: `frontend/src/routes/business/+page.svelte`
- Stores/types: `frontend/src/lib/business/*.ts` (state, store, snapshot, validation, sync, projectStore, sprintStore, resourceStore, types, utils, theme.css)
- Shared contracts: `shared/businessContracts.ts`
- View components: `frontend/src/lib/components/business/*.svelte`
  - Calendar, KanbanBoard, ProjectsView, DiaryView, TaskPanel
  - Plus modals: CalendarEventModal, KanbanTaskModal, ProjectModal, SprintModal, TodoTaskModal

## Existing features (must preserve on merge)

- Calendar, Journal, Projects, Kanban tabs
- Quick-stats header (overdue, today counts)
- Guest access flow: `GuestCodePrompt.svelte` + read-only mode
- Import / export of business data
- Optional chat sidepanel inside the business page
- `BusinessPrivacyToggle.svelte` for visibility controls

## Integration anchors in main app

- `frontend/src/routes/+page.svelte` — Ctrl+Shift+1 hardcodes `window.location.href = '/business'`; migrate to surface mode.
- `frontend/src/lib/components/MainLayout.svelte` — main chrome + right panel mount point.
- `frontend/src/lib/components/RightPanel.svelte` — supports stacked tabs/drawer, pinned stacks, split panels.
- `frontend/src/lib/components/ChannelSidebar.svelte` — left rail, future icon entry point.
- `frontend/src/lib/components/LayoutRouter.svelte` — picks workspace surfaces.

## Deferred items (do not block merge)

- Real Odoo integration / webhooks
- Server-side persistence for business data
- Auth/role gates on business features
- Camera add-on, document approval workflows
