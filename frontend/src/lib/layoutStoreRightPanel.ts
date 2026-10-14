/**
 * layoutStoreRightPanel.ts
 * Right panel operations — edge stub system (peek / pin / strip)
 */

import { get, writable } from 'svelte/store';
import { type WorkspacePanelId } from '$lib/docking/layoutSchema';
import { rightPanelMode, pinnedPanelId, activeRightTab, stubStrip, stubSide, dockStack, dockStackLimit, clampDockStackLimit, DEFAULT_STUB_STRIP, isMobile } from './layoutStoreStates';
import { normalizePanelIdForRuntime } from './layoutStoreUtils';

function displayedTab(): WorkspacePanelId {
	return get(activeRightTab);
}

/**
 * Center-stage guard (design contract §8.4, dockClamp.ts). MainLayout measures the shell and
 * publishes whether a companion can pin beside the stage and still leave it 600px. When it cannot,
 * opening a panel on purpose makes a held peek instead of a pin.
 */
export const dockCanPin = writable(true);

/**
 * A peek the person opened on purpose (click, tap, Enter) because pinning would crush the stage.
 * Unlike a hover peek it does not retract when the pointer leaves; the stage scrim, Escape, the
 * panel's close button or the same stub close it. It becomes a pin once the stage has room.
 */
export const peekHeld = writable(false);

/** Open a held peek of one panel (replacing whatever was shown). */
function holdPeek(panelId: WorkspacePanelId): void {
	if (get(rightPanelMode) === 'pinned') {
		// Pins that cannot sit beside the stage at this width are presented as a peek already;
		// opening another panel replaces them with a single held peek.
		pinnedPanelId.set(null);
		dockStack.set([]);
	}
	addStub(panelId);
	activeRightTab.set(panelId);
	peekHeld.set(true);
	rightPanelMode.set('peek');
}

function isHeldPeek(): boolean {
	return get(rightPanelMode) === 'peek' && get(peekHeld);
}

/**
 * A rail stub was clicked: pin it beside the stage when the clamp allows (pinPanel's toggle
 * semantics), otherwise toggle a held peek of it. Hover and focus never come through here.
 */
export function openPanelFromRail(panelId: WorkspacePanelId): void {
	const normalized = normalizePanelIdForRuntime(panelId);
	const showing = get(rightPanelMode) !== 'none' && get(activeRightTab) === normalized;
	// The panel already open on purpose (a held peek, or a pin shown as a peek) closes again.
	if (showing && (isHeldPeek() || (get(rightPanelMode) === 'pinned' && !get(dockCanPin)))) {
		closeRightPanel();
		return;
	}
	if (get(dockCanPin)) {
		pinPanel(normalized);
		return;
	}
	// A hover peek of this stub is committed by the click; another panel replaces what is shown.
	holdPeek(normalized);
}

// A held peek is a pin waiting for room: once the stage can keep 600px beside it, it pins.
dockCanPin.subscribe((canPin) => {
	if (canPin && isHeldPeek()) pinPanel(get(activeRightTab));
});

/** Everything pinned in the dock, in pin order. */
export function pinnedIds(): WorkspacePanelId[] {
	if (get(rightPanelMode) !== 'pinned') return [];
	const stack = get(dockStack);
	if (stack.length > 0) return stack;
	const single = get(pinnedPanelId);
	return single ? [single] : [];
}

/** The pinned panels laid out top to bottom: the rail's order, so reordering the rail rearranges the dock. */
export function dockOrder(ids: readonly WorkspacePanelId[], strip: readonly string[]): WorkspacePanelId[] {
	const position = (id: string) => {
		const index = strip.indexOf(id);
		return index === -1 ? Number.MAX_SAFE_INTEGER : index;
	};
	return [...ids].sort((a, b) => position(a) - position(b));
}

function isPinnedTo(panelId: WorkspacePanelId): boolean {
	return pinnedIds().includes(panelId);
}

export function peekPanel(panelId: WorkspacePanelId): void {
	const normalized = normalizePanelIdForRuntime(panelId);
	activeRightTab.set(normalized);
	if (get(rightPanelMode) === 'none') {
		peekHeld.set(false);
		rightPanelMode.set('peek');
	}
}

export function dismissPeek(): void {
	// A held peek stays until it is closed on purpose; only hover peeks retract on pointer leave.
	if (get(peekHeld) && get(rightPanelMode) === 'peek') return;
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

/**
 * Click on a rail item: pin it beside whatever is already pinned (up to the user's dock limit, oldest drops off),
 * or unpin it if it was already there. The last panel left pinned closes the dock.
 */
export function pinPanel(panelId: WorkspacePanelId): void {
	const normalized = normalizePanelIdForRuntime(panelId);
	const current = pinnedIds();
	if (current.includes(normalized)) {
		const rest = current.filter((id) => id !== normalized);
		if (rest.length === 0) {
			unpinPanel();
			return;
		}
		dockStack.set(rest);
		const focus = rest[rest.length - 1];
		pinnedPanelId.set(focus);
		activeRightTab.set(focus);
		return;
	}
	addStub(normalized);
	const next = [...current, normalized].slice(-clampDockStackLimit(get(dockStackLimit)));
	dockStack.set(next);
	peekHeld.set(false);
	rightPanelMode.set('pinned');
	pinnedPanelId.set(normalized);
	activeRightTab.set(normalized);
}

/** Unpin one panel from the dock stack (the section's × button). */
export function unpinOne(panelId: WorkspacePanelId): void {
	if (isPinnedTo(normalizePanelIdForRuntime(panelId))) pinPanel(panelId);
}

export function unpinPanel(): void {
	peekHeld.set(false);
	rightPanelMode.set('none');
	pinnedPanelId.set(null);
	dockStack.set([]);
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
	// Opening a conversation in an already-open panel must not toggle it shut.
	if (isPinnedTo(normalized)) {
		activeRightTab.set(normalized);
		return;
	}
	// No room beside the stage (desktop): open, never toggle shut, a held peek instead of a pin.
	// Phones show every panel as a sheet, so the guard does not apply there.
	if (!get(dockCanPin) && !get(isMobile)) {
		holdPeek(normalized);
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

/** Change how many panels may be pinned at once; a lower limit drops the oldest pins immediately. */
export function setDockStackLimit(limit: number): void {
	const next = clampDockStackLimit(limit);
	dockStackLimit.set(next);
	const stack = get(dockStack);
	if (stack.length > next) {
		const kept = stack.slice(-next);
		dockStack.set(kept);
		const focus = kept[kept.length - 1];
		pinnedPanelId.set(focus);
		activeRightTab.set(focus);
	}
}
