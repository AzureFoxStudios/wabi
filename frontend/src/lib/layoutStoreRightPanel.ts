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
 * Unlike a hover peek it does not retract when the pointer leaves; the stage scrim, Escape
 * (endPeek) or the same stub put it away. It becomes a pin once the stage has room.
 * Over a stowed pin (below) it shows a panel without touching the pin: rightPanelMode stays
 * 'pinned' and peekHeld is what puts the panel on screen.
 */
export const peekHeld = writable(false);

/**
 * The hover peek on screen was asked for from the rail (the peek modifier, hover-to-peek, or a peek
 * following the pointer along the rail). A peek the app opens on its own, such as the Calls peek on
 * joining a call (calling_impl_core summonCallsStubOnJoin), is not: it never scrims the stage.
 * A held peek is always asked for; peekHeld says so.
 */
export const peekRequested = writable(false);

/**
 * A committed pin that has no room beside the stage (the window narrowed, the sidebar widened, a
 * pin restored on a small screen) stays pinned, because it is the person's saved layout, but it is
 * off screen and the stage keeps its width. It comes back in flow once the stage can keep 600px.
 * Nothing about it changes on its own: no scrim, no takeover of the stage. MainLayout keeps its
 * zone mounted, hidden and inert, so the panel's own state (search text, picked channel, scroll)
 * survives; focus that was inside waits on the panel's stub and goes back when the pin returns.
 * Only an explicit close or unpin removes it. Phones show every panel as a sheet, so nothing is
 * stowed there.
 */
export function pinStowed(): boolean {
	return get(rightPanelMode) === 'pinned' && !get(dockCanPin) && !get(isMobile);
}

/** Open a held peek of one panel (replacing whatever peek was shown; a stowed pin is kept). */
function holdPeek(panelId: WorkspacePanelId): void {
	addStub(panelId);
	activeRightTab.set(panelId);
	peekHeld.set(true);
	if (get(rightPanelMode) !== 'pinned') rightPanelMode.set('peek');
}

/** End a held peek: over a stowed pin the pin stays and the displayed tab returns to it. */
function endHeldPeek(): void {
	if (get(rightPanelMode) !== 'pinned') {
		unpinPanel();
		return;
	}
	peekHeld.set(false);
	const committed = get(pinnedPanelId);
	if (committed) activeRightTab.set(committed);
}

/**
 * A rail stub was clicked: pin it beside the stage when the clamp allows (pinPanel's toggle
 * semantics), otherwise toggle a held peek of it. Hover and focus never come through here.
 */
export function openPanelFromRail(panelId: WorkspacePanelId): void {
	const normalized = normalizePanelIdForRuntime(panelId);
	if (get(dockCanPin) || get(isMobile)) {
		pinPanel(normalized);
		return;
	}
	// No room: the panel already open on purpose closes again (a stowed pin is left as it is).
	if (get(peekHeld) && get(rightPanelMode) !== 'none' && get(activeRightTab) === normalized) {
		endHeldPeek();
		return;
	}
	// A hover peek of this stub is committed by the click; another panel replaces what is shown.
	holdPeek(normalized);
}

// A held peek is a pin waiting for room: once the stage can keep 600px beside it, it pins.
// Over a stowed pin, the pin comes back in flow and a peek of another panel joins it.
dockCanPin.subscribe((canPin) => {
	if (!canPin || !get(peekHeld)) return;
	const mode = get(rightPanelMode);
	const shown = get(activeRightTab);
	if (mode === 'pinned' && pinnedIds().includes(shown)) peekHeld.set(false);
	else if (mode !== 'none') pinPanel(shown);
});

// Whatever ends the peek (close, a pin restored over it, the phone layout taking over) ends the hold.
let lastRightPanelMode = get(rightPanelMode);
rightPanelMode.subscribe((mode) => {
	const from = lastRightPanelMode;
	lastRightPanelMode = mode;
	if (mode !== 'peek') peekRequested.set(false);
	if (!get(peekHeld)) return;
	if (mode === 'none' || (mode === 'pinned' && from !== 'pinned')) peekHeld.set(false);
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
		peekRequested.set(false);
		rightPanelMode.set('peek');
	}
}

/** A hover peek the person asked for on the rail: the same peek, and the stage gets the scrim. */
export function peekPanelFromRail(panelId: WorkspacePanelId): void {
	peekPanel(panelId);
	if (get(rightPanelMode) === 'peek') peekRequested.set(true);
}

export function dismissPeek(): void {
	// A held peek stays until it is closed on purpose; only hover peeks retract on pointer leave.
	if (get(peekHeld) && get(rightPanelMode) !== 'none') return;
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

/** Unpin one panel from the dock stack (a stacked section's ×, the rail menu's Unpin), stowed or not. */
export function unpinOne(panelId: WorkspacePanelId): void {
	if (isPinnedTo(normalizePanelIdForRuntime(panelId))) pinPanel(panelId);
}

export function unpinPanel(): void {
	peekHeld.set(false);
	rightPanelMode.set('none');
	pinnedPanelId.set(null);
	dockStack.set([]);
}

/**
 * Close the companion: every pin and any peek go, with the same result at every window width (a
 * stowed pin too). Code that closes the panel as part of an action (navigation, "show in center
 * stage") can rely on it. Escape and the stage scrim mean "put the peek away" and use endPeek().
 */
export function closeRightPanel(): void {
	if (get(rightPanelMode) === 'none') return;
	unpinPanel();
}

/**
 * Escape and the stage scrim: end the peek on screen and nothing else. A plain peek closes; a
 * held peek over a stowed pin goes and the pin stays. A pin in flow, or a stowed pin with nothing
 * over it, is left alone (unpinning is explicit: the rail menu's Unpin, a section's ×).
 * Returns whether a peek was ended.
 */
export function endPeek(): boolean {
	const mode = get(rightPanelMode);
	if (mode === 'peek') {
		unpinPanel();
		return true;
	}
	if (mode === 'pinned' && get(peekHeld)) {
		endHeldPeek();
		return true;
	}
	return false;
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
	// No room beside the stage (desktop): open, never toggle shut, a held peek instead of a pin.
	// A stowed pin of this panel is shown the same way; the pin itself is kept.
	// Phones show every panel as a sheet, so the guard does not apply there.
	if (!get(dockCanPin) && !get(isMobile)) {
		holdPeek(normalized);
		return;
	}
	// Opening a conversation in an already-open panel must not toggle it shut.
	if (isPinnedTo(normalized)) {
		activeRightTab.set(normalized);
		return;
	}
	pinPanel(normalized);
}

export function setDisplayedPanel(panelId: WorkspacePanelId): void {
	const normalized = normalizePanelIdForRuntime(panelId);
	// A stowed pin is off screen, so displaying one of its panels shows it as a held peek.
	if (pinStowed()) {
		holdPeek(normalized);
		return;
	}
	activeRightTab.set(normalized);
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
