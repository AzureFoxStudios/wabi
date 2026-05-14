/**
 * layoutStoreUtils.ts
 * Utility functions for dock and panel manipulation
 */

import { get } from 'svelte/store';
import { normalizePanelDock, cloneWorkspace, FALLBACK_WORKSPACE_PANEL_ID, getNavTabset, getAuxTabset, buildPhase1Root, type WorkspacePanelDockV1, type WorkspacePanelId, type WorkspacePanelStackV1, type WorkspaceLayoutV1 } from '$lib/docking/layoutSchema';
import { activeWorkspace, navDock, channelSidebarWidth, rightPanelView, rightPanelDock, activeRightTab, layoutState, setIsApplyingLayout, DEFAULT_CONSTANTS } from './layoutStoreStates';

export function getDockActivePanelId(dock: WorkspacePanelDockV1): WorkspacePanelId {
	const expandedStack = dock.stacks.find((stack) => !stack.collapsed && stack.tabs.includes(stack.activePanelId));
	if (expandedStack) return expandedStack.activePanelId;
	const firstStack = dock.stacks.find((stack) => stack.tabs.length > 0);
	return firstStack?.activePanelId || firstStack?.tabs[0] || FALLBACK_WORKSPACE_PANEL_ID;
}

export function clonePanelDock(dock: WorkspacePanelDockV1): WorkspacePanelDockV1 {
	return {
		...dock,
		stacks: dock.stacks.map((stack) => ({
			...stack,
			tabs: [...stack.tabs]
		}))
	};
}

export function createStack(
	id: string,
	tabs: WorkspacePanelId[],
	activePanelId: WorkspacePanelId,
	size: number
): WorkspacePanelStackV1 {
	return {
		id,
		tabs,
		activePanelId: tabs.includes(activePanelId) ? activePanelId : tabs[0] || FALLBACK_WORKSPACE_PANEL_ID,
		size,
		minSize: 22,
		maxSize: 100,
		collapsed: false,
		pinned: true
	};
}

export function normalizePanelIdForRuntime(panelId: string): WorkspacePanelId {
	const { isValidWorkspacePanelId } = require('$lib/docking/layoutSchema');
	return isValidWorkspacePanelId(panelId) ? panelId.trim() : FALLBACK_WORKSPACE_PANEL_ID;
}

export function activatePanelInDock(dock: WorkspacePanelDockV1, panelId: WorkspacePanelId): WorkspacePanelDockV1 {
	const next = clonePanelDock(dock);
	let owningStack = next.stacks.find((stack) => stack.tabs.includes(panelId));
	if (!owningStack) {
		owningStack = next.stacks[0];
		if (!owningStack) {
			next.stacks = [createStack('stack-primary', [panelId], panelId, 100)];
			owningStack = next.stacks[0];
		} else {
			owningStack.tabs = [...owningStack.tabs, panelId];
		}
	}
	owningStack.activePanelId = panelId;
	owningStack.collapsed = false;
	return normalizePanelDock({ ...next, updatedAt: Date.now() }, get(activeWorkspace));
}

export function setPanelDock(nextDock: WorkspacePanelDockV1): void {
	const normalized = normalizePanelDock(nextDock, get(activeWorkspace));
	rightPanelDock.set(normalized);
	const activePanelId = getDockActivePanelId(normalized);
	activeRightTab.set(activePanelId);
	if (get(rightPanelView) !== 'none') {
		rightPanelView.set(activePanelId);
	}
}

export function withActiveWorkspace(mutator: (workspace: WorkspaceLayoutV1) => WorkspaceLayoutV1): void {
	const { createDefaultWorkspaceLayout, getWorkspace } = require('$lib/docking/layoutSchema');
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
	rightPanelDock.set(dock);
	activeRightTab.set(activePanelId);

	const { isMobile } = require('./layoutStoreStates');
	if (!get(isMobile)) {
		if (aux.collapsed) {
			rightPanelView.set('none');
		} else {
			rightPanelView.set(activePanelId);
		}
	}

	activeWorkspace.set(workspace.name);
	setIsApplyingLayout(false);
}

export function syncWorkspaceFromRuntime(): void {
	const { layoutLoaded, setIsApplyingLayout } = require('./layoutStoreStates');
	if (get({ layoutLoaded }) || !get({ layoutLoaded })) {
		const { getWorkspace } = require('$lib/docking/layoutSchema');

		withActiveWorkspace((workspace) => {
			const side = get(navDock);
			const navTab = getNavTabset(workspace);
			const auxTab = getAuxTabset(workspace);

			const runtimeNavWidth = get(channelSidebarWidth);
			const runtimeAuxWidth = get(rightPanelWidth);
			const auxOpen = get(rightPanelView) !== 'none';

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
					!auxOpen || runtimeAuxWidth <= 0
				),
				panelDock: normalizePanelDock(get(rightPanelDock), workspace.name),
				updatedAt: Date.now()
			};
		});
	}
}
