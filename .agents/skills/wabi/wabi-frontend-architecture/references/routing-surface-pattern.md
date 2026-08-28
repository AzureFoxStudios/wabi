# Routing / Surface Pattern

## Key files and roles

- `frontend/src/routes/+page.svelte` — boot/auth shell only. It initializes socket/auth/theme and mounts `LayoutRouter`. Business shortcuts previously lived here as `window.location.href = '/business'`; move them into surface/routing logic.
- `frontend/src/lib/components/LayoutRouter.svelte` — chooses workspace surface. When adding a new surface mode, add it here rather than scattering conditional nav rules.
- `frontend/src/lib/components/MainLayout.svelte` — chrome wrapper around any surface: server rail, channel sidebar, center workspace area, right panel. Handles mobile panel visibility and resizing.
- `frontend/src/lib/components/RightPanel.svelte` — tab-stacked right panel. Supports split stacks, pinned stacks, drawer overflow, and resize.
- `frontend/src/lib/layoutStore*.ts` — layout preferences, dock state, right panel width/view, mobile behavior, workspace panel state.
- `frontend/src/lib/components/ChannelSidebar.svelte` — left rail list of channels/surfaces. New entry points for Business or other surfaces should be added here.

## Surface mode wiring pattern (P1)

1. Extend whichever layout router / surface enum drives `MainLayout` center content.
2. Import standalone module stores/components into the main surface mode.
3. Keep the old `routes/<surface>/+page.svelte` file in place initially; it becomes the fallback while the new surface matures.
4. Once stable, the old standalone page can redirect into the new mode or itself become a thin mount to shared business stores.

## Panelization pattern (P2)

- Use `layoutStore.openRightPanel(id)` to open a surface view as a right panel stack.
- Use `layoutStore.splitRightPanelTab(panelId)` if the surface supports split-view.
- Pin stacks when the surface must persist across workspace switches.

## Legacy redirect pattern (P3)

- Add a check in the old standalone route that redirects to the new surface mode a single time, preserving query/state where possible.
- Validate redirect in a real browser before removing the old page file or updating navigation references.
