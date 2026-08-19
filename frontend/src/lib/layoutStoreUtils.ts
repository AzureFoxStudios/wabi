/**
 * layoutStoreUtils.ts
 * Utility functions for dock and panel manipulation
 */

import { get } from 'svelte/store';
import { normalizePanelDock, cloneWorkspace, FALLBACK_WORKSPACE_PANEL_ID, getNavTabset, getAuxTabset, buildPhase1Root, isValidWorkspacePanelId, createDefaultWorkspaceLayout, getWorkspace, type WorkspacePanelDockV1, type WorkspacePanelId, type WorkspaceLayoutV1 } from '$lib/docking/layoutSchema';
import { activeWorkspace, navDock, channelSidebarWidth, rightPanelWidth, rightPanelMode, pinnedPanelId, activeRightTab, stubStrip, layoutState, layoutLoaded, setIsApplyingLayout, DEFAULT_CONSTANTS, isMobile } from './layoutStoreStates';

export function getDockActivePanelId(dock: WorkspacePanelDockV1): WorkspacePanelId {
	const expandedStack = dock.stacks.find((stack) => !stack.collapsed && stack.tabs.includes(stack.activePanelId));
	if (expandedStack) return expandedStack.activePanelId;
	const firstStack = dock.stacks.find((stack) => stack.tabs.length > 0);
	return firstStack?.activePanelId || firstStack?.tabs[0] || FALLBACK_WORKSPACE_PANEL_ID;
}

export function normalizePanelIdForRuntime(panelId: string): WorkspacePanelId {
	return isValidWorkspacePanelId(panelId) ? panelId.trim() : FALLBACK_WORKSPACE_PANEL_ID;
}

export function withActiveWorkspace(mutator: (workspace: WorkspaceLayoutV1) => WorkspaceLayoutV1): void {
	layoutState.update((state) => {
		const current = state.workspaces[state.activeWorkspace] || createDefaultWorkspaceLayout(state.activeWorkspace);
		const next = mutator(current);
		return {
			...state,
			workspaces: {
				...state.workspaces,
				[next.name]: next
			},
			activeWorkspace: next.name,
			updatedAt: Date.now()
		};
	});
}

export function applyWorkspaceToRuntime(workspace: WorkspaceLayoutV1): void {
	setIsApplyingLayout(true);
	navDock.set(workspace.navDock);

	const nav = getNavTabset(workspace);
	const aux = getAuxTabset(workspace);
	const dock = normalizePanelDock(workspace.panelDock, workspace.name);
	const activePanelId = getDockActivePanelId(dock);

	channelSidebarWidth.set(nav.collapsed ? 0 : nav.size);
	rightPanelWidth.set(aux.size);
	activeRightTab.set(activePanelId);

	if (!get(isMobile)) {
		if (aux.collapsed) {
			rightPanelMode.set('none');
			pinnedPanelId.set(null);
		} else {
			// Boot restore sets mode/pin directly — must NOT mutate the stub strip.
			rightPanelMode.set('pinned');
			pinnedPanelId.set(activePanelId);
			activeRightTab.set(activePanelId);
		}
	}

	activeWorkspace.set(workspace.name);
	setIsApplyingLayout(false);
}

export function syncWorkspaceFromRuntime(): void {
	if (!layoutLoaded) return;
	{
		withActiveWorkspace((workspace) => {
			const side = get(navDock);
			const navTab = getNavTabset(workspace);
			const auxTab = getAuxTabset(workspace);

			const runtimeNavWidth = get(channelSidebarWidth);
			const runtimeAuxWidth = get(rightPanelWidth);
			// Only a committed pin survives reload — peek is transient (spec §3).
			const auxPinned = get(rightPanelMode) === 'pinned';

			const nextNavSize = runtimeNavWidth > 0 ? runtimeNavWidth : navTab.size || DEFAULT_CONSTANTS.NAV_WIDTH;
			const nextAuxSize = runtimeAuxWidth > 0 ? runtimeAuxWidth : auxTab.size || DEFAULT_CONSTANTS.RIGHT_WIDTH;

			return {
				...workspace,
				navDock: side,
				root: buildPhase1Root(
					side,
					nextNavSize,
					runtimeNavWidth <= 0,
					nextAuxSize,
					!auxPinned
				),
				panelDock: buildRuntimePanelDock(get(stubStrip), get(pinnedPanelId) ?? get(activeRightTab)),
				updatedAt: Date.now()
			};
		});
	}
}

/** Persist a minimal legacy-shaped dock derived from the strip so the one-time
 *  seed keeps continuity and old schema stays decodable. The active panel is
 *  the committed pin (not tabs[0]) so a reload restores the panel the user
 *  actually had pinned. */
function buildRuntimePanelDock(
	strip: WorkspacePanelId[],
	activePanel: WorkspacePanelId
): WorkspacePanelDockV1 {
	const tabs = strip.length > 0 ? strip : [FALLBACK_WORKSPACE_PANEL_ID];
	const activePanelId = tabs.includes(activePanel) ? activePanel : tabs[0];
	return normalizePanelDock(
		{
			orientation: 'vertical',
			stacks: [
				{
					id: 'stack-primary',
					tabs,
					activePanelId,
					size: 100,
					minSize: 22,
					maxSize: 100,
					collapsed: false,
					pinned: true
				}
			],
			overflowThreshold: 5,
			updatedAt: Date.now()
		},
		get(activeWorkspace)
	);
}