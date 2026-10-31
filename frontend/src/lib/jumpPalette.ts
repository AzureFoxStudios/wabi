/**
 * Open state for the jump palette (Ctrl K), design contract §7.24.
 *
 * `JumpPalette.svelte` is mounted once by the shell and reads `palette`; anything that opens
 * it (the Ctrl K handler, the sidebar "Search or jump to" field, a folio "More" hint) calls
 * `openPalette`. The palette's results live in `jumpIndex.ts`; this module owns only whether
 * it is open, in which scope, and where focus returns when it closes.
 */
import { derived, get, writable, type Readable } from 'svelte/store';

export type PaletteScope = 'all' | 'channels' | 'people' | 'workspaces' | 'actions';

/** Chip order in the scope row; Tab / Shift+Tab walk it. */
export const PALETTE_SCOPES: readonly PaletteScope[] = Object.freeze(['all', 'channels', 'people', 'workspaces', 'actions']);

export const PALETTE_SCOPE_LABEL: Readonly<Record<PaletteScope, string>> = Object.freeze({
	all: 'Everything',
	channels: 'Channels',
	people: 'People',
	workspaces: 'Workspaces',
	actions: 'Actions'
});

/** Typing one of these as the first character switches to its scope. */
export const PALETTE_SCOPE_PREFIX: Readonly<Record<Exclude<PaletteScope, 'all'>, string>> = Object.freeze({
	channels: '#',
	people: '@',
	workspaces: '/',
	actions: '>'
});

export interface PaletteState {
	open: boolean;
	scope: PaletteScope;
	/** Initial query for this opening (e.g. what was typed into the sidebar field). */
	query: string;
	/** Increments on every opening from closed, so the palette can reset its highlight and input. */
	session: number;
}

export interface OpenPaletteOptions {
	query?: string;
	/** Where focus returns on close. Defaults to the element focused when the palette opened. */
	origin?: Element | null;
}

const state = writable<PaletteState>({ open: false, scope: 'all', query: '', session: 0 });
let origin: HTMLElement | null = null;

/** The whole palette state, read-only. */
export const palette: Readable<PaletteState> = { subscribe: state.subscribe };
export const paletteOpen: Readable<boolean> = derived(state, ($state) => $state.open);
export const paletteScope: Readable<PaletteScope> = derived(state, ($state) => $state.scope);

export function isPaletteScope(value: unknown): value is PaletteScope {
	return typeof value === 'string' && (PALETTE_SCOPES as readonly string[]).includes(value);
}

function focusable(element: Element | null | undefined): HTMLElement | null {
	if (!element || typeof (element as HTMLElement).focus !== 'function') return null;
	// The document body is not an origin: there is nothing to return to.
	if (typeof document !== 'undefined' && element === document.body) return null;
	return element as HTMLElement;
}

/**
 * Open the palette in `scope` (Everything by default). While it is open this only switches
 * scope (and the query, when one is given); the origin and session are kept.
 */
export function openPalette(scope: PaletteScope = 'all', options: OpenPaletteOptions = {}): void {
	const current = get(state);
	const nextScope = isPaletteScope(scope) ? scope : 'all';
	if (current.open) {
		state.set({ ...current, scope: nextScope, query: options.query ?? current.query });
		return;
	}
	origin = focusable(options.origin !== undefined ? options.origin : typeof document !== 'undefined' ? document.activeElement : null);
	state.set({ open: true, scope: nextScope, query: options.query ?? '', session: current.session + 1 });
}

/**
 * Close the palette. Focus returns to where it was opened from unless `restoreFocus` is
 * false (opening a result moves focus to that result's place instead).
 */
export function closePalette(options: { restoreFocus?: boolean } = {}): void {
	const current = get(state);
	if (!current.open) return;
	const returnTo = origin;
	origin = null;
	state.set({ ...current, open: false, query: '' });
	if (options.restoreFocus === false || !returnTo || returnTo.isConnected === false) return;
	try {
		returnTo.focus({ preventScroll: true });
	} catch {
		/* The origin may have become unfocusable; leaving focus where it is is safe. */
	}
}

/** Ctrl K toggles: it opens the palette, and closes it when it is already open. */
export function togglePalette(scope: PaletteScope = 'all'): void {
	if (get(state).open) closePalette();
	else openPalette(scope);
}

/** Switch scope from the chip row or the Tab key; ignored while closed. */
export function setPaletteScope(scope: PaletteScope): void {
	if (!isPaletteScope(scope)) return;
	state.update(($state) => ($state.open && $state.scope !== scope ? { ...$state, scope } : $state));
}

/** The scope after `scope` in chip order (`step` -1 for Shift+Tab), wrapping. */
export function nextPaletteScope(scope: PaletteScope, step: 1 | -1 = 1): PaletteScope {
	const index = Math.max(0, PALETTE_SCOPES.indexOf(scope));
	return PALETTE_SCOPES[(index + step + PALETTE_SCOPES.length) % PALETTE_SCOPES.length];
}

/** A leading `#`, `@`, `/` or `>` switches scope and is not part of the query. */
export function parsePaletteInput(raw: string, scope: PaletteScope): { scope: PaletteScope; query: string } {
	const first = raw.charAt(0);
	for (const [prefixScope, prefix] of Object.entries(PALETTE_SCOPE_PREFIX) as [PaletteScope, string][]) {
		if (first === prefix) return { scope: prefixScope, query: raw.slice(1) };
	}
	return { scope, query: raw };
}

/**
 * Ctrl K (⌘K on macOS), without Shift or Alt, so Ctrl Shift K stays free. The physical K key
 * also counts when the layout types no Latin letter there (Cyrillic `л`, Greek `κ`), so the
 * shortcut works on every layout; a Latin layout that moves K (Dvorak) keeps its own letter.
 */
export function isPaletteShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'> & { code?: string; isComposing?: boolean }): boolean {
	if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.isComposing) return false;
	const key = event.key.toLowerCase();
	return key === 'k' || (event.code === 'KeyK' && !/^[a-z]$/.test(key));
}
