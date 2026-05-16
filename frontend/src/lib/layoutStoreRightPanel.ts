/**
 * layoutStoreRightPanel.ts
 * Right panel operations and management
 */

import { get } from 'svelte/store';
import { type WorkspacePanelId, FALLBACK_WORKSPACE_PANEL_ID, createDefaultPanelDock } from '$lib/docking/layoutSchema';
import { rightPanelView, activeRightTab, rightPanelDock } from './layoutStoreStates';
import { activatePanelInDock, getDockActivePanelId, createStack, clonePanelDock, setPanelDock, normalizePanelIdForRuntime } from './layoutStoreUtils';
import { scheduleSyncWorkspace } from './layoutStoreSync';

export function toggleRightPanel(): void {
	rightPanelView.update((current) => {
		if (current === 'none') {
			return get(activeRightTab);
		}
		return 'none';
	});
}

export function openRightPanel(panelId: string): void {
	const normalizedPanelId = normalizePanelIdForRuntime(panelId);
	activeRightTab.set(normalizedPanelId);
	rightPanelDock.update((dock) => activatePanelInDock(dock, normalizedPanelId));
	rightPanelView.set(normalizedPanelId);
}

export function setActiveRightPanel(panelId: string): void {
	const normalized = normalizePanelIdForRuntime(panelId);
	activeRightTab.set(normalized);
	rightPanelDock.update((dock) => activatePanelInDock(dock, normalized));
	if (get(rightPanelView) !== 'none') {
		rightPanelView.set(normalized);
	}
}

export function updateRightPanelDock(mutator: (dock: any) => any): void {
	rightPanelDock.update(mutator);
}

export function moveRightPanelTab(panelId: string, targetStackId: string, targetIndex = -1): void {
	rightPanelDock.update((dock) => {
		const next = clonePanelDock(dock);
		const sourceStack = next.stacks.find((s) => s.tabs.includes(panelId));
		if (!sourceStack) return dock;

		sourceStack.tabs = sourceStack.tabs.filter((t) => t !== panelId);
		if (sourceStack.tabs.length === 0 && next.stacks.length > 1) {
			const stackIndex = next.stacks.indexOf(sourceStack);
			next.stacks.splice(stackIndex, 1);
		} else if (sourceStack.tabs.length > 0 && sourceStack.activePanelId === panelId) {
			sourceStack.activePanelId = sourceStack.tabs[0] || FALLBACK_WORKSPACE_PANEL_ID;
		}

		let targetStack = next.stacks.find((s) => s.id === targetStackId);
		if (!targetStack) {
			targetStack = createStack(targetStackId, [panelId], panelId, 50);
			next.stacks.push(targetStack);
		} else {
			if (targetIndex >= 0 && targetIndex <= targetStack.tabs.length) {
				targetStack.tabs.splice(targetIndex, 0, panelId);
			} else {
				targetStack.tabs.push(panelId);
			}
			targetStack.activePanelId = panelId;
		}

		next.updatedAt = Date.now();
		return next;
	});
	scheduleSyncWorkspace();
}

export function splitRightPanelTab(panelId: string): void {
	rightPanelDock.update((dock) => {
		const next = clonePanelDock(dock);
		const sourceStack = next.stacks.find((s) => s.tabs.includes(panelId));
		if (!sourceStack) return dock;

		const newStackId = `stack-${Date.now()}`;
		const newStack = createStack(newStackId, [panelId], panelId, Math.ceil(sourceStack.size / 2));
		sourceStack.tabs = sourceStack.tabs.filter((t) => t !== panelId);

		if (sourceStack.tabs.length === 0 && next.stacks.length > 1) {
			const stackIndex = next.stacks.indexOf(sourceStack);
			next.stacks.splice(stackIndex, 1);
		} else if (sourceStack.tabs.length > 0 && sourceStack.activePanelId === panelId) {
			sourceStack.activePanelId = sourceStack.tabs[0] || FALLBACK_WORKSPACE_PANEL_ID;
			sourceStack.size = Math.ceil(sourceStack.size / 2);
		}

		next.stacks.push(newStack);
		next.updatedAt = Date.now();
		return next;
	});
	scheduleSyncWorkspace();
}

export function resizeRightPanelStacks(primarySize: number): void {
	rightPanelDock.update((dock) => {
		const next = clonePanelDock(dock);
		if (next.stacks.length === 0) return dock;
		next.stacks[0].size = primarySize;
		next.updatedAt = Date.now();
		return next;
	});
	scheduleSyncWorkspace();
}

export function toggleRightPanelStackCollapsed(stackId: string): void {
	rightPanelDock.update((dock) => {
		const next = clonePanelDock(dock);
		const stack = next.stacks.find((s) => s.id === stackId);
		if (stack) {
			stack.collapsed = !stack.collapsed;
			next.updatedAt = Date.now();
		}
		return next;
	});
	scheduleSyncWorkspace();
}

export function toggleRightPanelStackPinned(stackId: string): void {
	rightPanelDock.update((dock) => {
		const next = clonePanelDock(dock);
		const stack = next.stacks.find((s) => s.id === stackId);
		if (stack) {
			stack.pinned = !stack.pinned;
			next.updatedAt = Date.now();
		}
		return next;
	});
	scheduleSyncWorkspace();
}

export function mergeRightPanelStack(stackId: string): void {
	rightPanelDock.update((dock) => {
		const next = clonePanelDock(dock);
		if (next.stacks.length <= 1) return dock;

		const sourceIndex = next.stacks.findIndex((stack) => stack.id === stackId);
		if (sourceIndex < 0) return dock;

		const source = next.stacks[sourceIndex];
		const target = next.stacks[sourceIndex === 0 ? 1 : 0];
		if (!target) return dock;

		for (const tab of source.tabs) {
			if (!target.tabs.includes(tab)) {
				target.tabs.push(tab);
			}
		}

		target.activePanelId = source.activePanelId;
		target.collapsed = false;
		target.size = 100;
		next.stacks.splice(sourceIndex, 1);
		next.stacks = next.stacks.map((stack) => ({ ...stack, collapsed: false, size: 100 }));
		next.updatedAt = Date.now();
		return next;
	});
	scheduleSyncWorkspace();
}

export function resetRightPanelDock(): void {
	rightPanelDock.set(createDefaultPanelDock());
	scheduleSyncWorkspace();
}
