/**
 * layoutStoreRightPanel.ts
 * Right panel operations — edge stub system (peek / pin / strip)
 */

import { get } from 'svelte/store';
import { type WorkspacePanelId } from '$lib/docking/layoutSchema';
import { rightPanelMode, pinnedPanelId, activeRightTab, stubStrip, stubSide, DEFAULT_STUB_STRIP } from './layoutStoreStates';
import { normalizePanelIdForRuntime } from './layoutStoreUtils';

function displayedTab(): WorkspacePanelId {
	return get(activeRightTab);
}

function isPinnedTo(panelId: WorkspacePanelId): boolean {
	return get(rightPanelMode) === 'pinned' && get(pinnedPanelId) === panelId;
}

export function peekPanel(panelId: WorkspacePanelId): void {
	const normalized = normalizePanelIdForRuntime(panelId);
	activeRightTab.set(normalized);
	if (get(rightPanelMode) === 'none') {
		rightPanelMode.set('peek');
	}
}

export function dismissPeek(): void {
	if (get(rightPanelMode) === 'pinned') {
		const committed = get(pinnedPanelId);
		if (committed && get(activeRightTab) !== committed) {
			activeRightTab.set(committed);
		}
		return;
	}
	if (get(rightPanelMode) === 'peek') {
		rightPanelMode.set('none');
	}
}

export function pinPanel(panelId: WorkspacePanelId): void {
	const normalized = normalizePanelIdForRuntime(panelId);
	if (isPinnedTo(normalized)) {
		unpinPanel();
		return;
	}
	addStub(normalized);
	rightPanelMode.set('pinned');
	pinnedPanelId.set(normalized);
	activeRightTab.set(normalized);
}

export function unpinPanel(): void {
	rightPanelMode.set('none');
	pinnedPanelId.set(null);
}

export function closeRightPanel(): void {
	if (get(rightPanelMode) === 'none') return;
	unpinPanel();
}

export function togglePinPanel(): void {
	if (get(rightPanelMode) === 'pinned' && get(pinnedPanelId)) {
		unpinPanel();
		return;
	}
	pinPanel(displayedTab());
}

export function openRightPanel(panelId: WorkspacePanelId, opts?: { pin?: boolean }): void {
	const normalized = normalizePanelIdForRuntime(panelId);
	if (opts?.pin === false) {
		peekPanel(normalized);
		return;
	}
	pinPanel(normalized);
}

export function setDisplayedPanel(panelId: WorkspacePanelId): void {
	activeRightTab.set(normalizePanelIdForRuntime(panelId));
}

export function addStub(panelId: WorkspacePanelId): void {
	const normalized = normalizePanelIdForRuntime(panelId);
	stubStrip.update((strip) => (strip.includes(normalized) ? strip : [...strip, normalized]));
}

export function removeStub(panelId: WorkspacePanelId): void {
	const normalized = normalizePanelIdForRuntime(panelId);
	stubStrip.update((strip) => strip.filter((id) => id !== normalized));
}

export function reorderStub(fromIndex: number, toIndex: number): void {
	stubStrip.update((strip) => {
		if (fromIndex < 0 || fromIndex >= strip.length) return strip;
		const next = [...strip];
		const [moved] = next.splice(fromIndex, 1);
		const clampedTo = Math.max(0, Math.min(toIndex, next.length));
		next.splice(clampedTo, 0, moved);
		return next;
	});
}

export function resetStubs(): void {
	stubStrip.set([...DEFAULT_STUB_STRIP]);
}

export function setStubSide(side: 'left' | 'right'): void {
	stubSide.set(side === 'left' ? 'left' : 'right');
}