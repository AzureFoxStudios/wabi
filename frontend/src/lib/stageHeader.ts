/**
 * Row A of the stage masthead (design contract §7.23, §8.2).
 *
 * `StageBar.svelte` is mounted once above every center-stage workspace and never unmounts on
 * view switches. A workspace describes its row A here instead of drawing its own header band:
 *
 *     setStageHeader('planner', { title: 'My Planner', scope: 'Only you · this device', status: 'Saved 09:41' });
 *     onDestroy(() => clearStageHeader('planner'));
 *
 * Rules:
 * - One entry per `owner`. A header belongs to one view: `view` when given, otherwise the view
 *   active when it is set. `stageHeader` only ever shows a header for the active view, so a
 *   workspace that is still mounted (or not yet cleared) can never relabel another workspace.
 * - Last writer wins per active view: the owner that most recently registered a header for
 *   the active view is shown. Updating an existing header in place (same owner, same view)
 *   keeps its position, so a reactive refresh such as "Saved 09:42" does not take the
 *   masthead from a more specific owner that registered later. Clearing reveals the previous
 *   owner; with no owner the StageBar falls back to its built-in row A for that view.
 * - Set from a reactive statement or `$effect`, and clear on destroy, not in the effect's
 *   teardown: a teardown that clears runs before every re-run and re-registers the owner on top.
 * - Only center-stage instances set the header. A component that can also mount in the
 *   companion panel must not call this from that instance.
 * - Truth labels follow §9: scope tags use the locality words ("Private · this device",
 *   "Shared · Editor"), the seal chip says "Server-readable", maturity says PREVIEW.
 */
import type { Component } from 'svelte';
import { derived, get, writable, type Readable } from 'svelte/store';
import type { WorkspaceViewKey } from './components/chat/types';
import type { IconName } from './components/ui/icons';
import { activeWorkspaceView } from './workspaceNavigationState';

/** A truth label in row A. */
export interface StageHeaderTag {
	label: string;
	/** `scope` → `.w-tag` (default) · `seal` → seal chip ("Server-readable") · `maturity` → `.w-tag--mat` (PREVIEW). */
	kind?: 'scope' | 'seal' | 'maturity';
	/** The full words for the tooltip and ⋯ when the tag collapses to its dot on a narrow stage. */
	title?: string;
}

/** One row A action. The StageBar renders these with the kit; a ⋯ menu anchors to `anchor`. */
export interface StageHeaderAction {
	id: string;
	/** Visible words, or the accessible name of an icon-only action. */
	label: string;
	icon?: IconName;
	/** Kit weight; icon-only actions are quiet icon buttons. */
	variant?: 'quiet' | 'default' | 'primary' | 'danger';
	iconOnly?: boolean;
	/** Toggle state (`aria-pressed`), e.g. Pinned. Omit for plain actions. */
	pressed?: boolean;
	disabled?: boolean;
	/** Shortcut shown in the tooltip, e.g. "Ctrl F". */
	shortcut?: string;
	onSelect: (anchor: HTMLElement) => void;
}

export interface StageHeaderInput {
	/** The workspace or document name (`--w-t-title`). */
	title: string;
	/** Scope/locality tags; a string is one scope tag. */
	scope?: string | StageHeaderTag | readonly StageHeaderTag[];
	/** Quiet status such as "Saved 09:41", announced politely (`role=status`). */
	status?: string;
	actions?: readonly StageHeaderAction[];
	/**
	 * Replaces the default title/scope/status layout of row A, e.g. the office editor header.
	 * Rendered as `<component {...props} />`; the actions still come from `actions`.
	 */
	// Row A hosts components with arbitrary props, so the prop type cannot be narrower.
	component?: Component<any>;
	props?: Record<string, unknown>;
	/** The view this header belongs to. Defaults to the view active at the call. */
	view?: WorkspaceViewKey;
}

/** What the StageBar reads: normalized, so consumers never branch on input shapes. */
export interface StageHeader {
	owner: string;
	view: WorkspaceViewKey;
	title: string;
	scope: readonly StageHeaderTag[];
	status: string | null;
	actions: readonly StageHeaderAction[];
	component: Component<any> | null;
	props: Record<string, unknown>;
}

interface Entry {
	order: number;
	header: StageHeader;
}

const NO_ACTIONS: readonly StageHeaderAction[] = Object.freeze([]);
const NO_PROPS: Record<string, unknown> = Object.freeze({}) as Record<string, unknown>;

function normalizeScope(scope: StageHeaderInput['scope']): StageHeaderTag[] {
	const tags = scope === undefined ? [] : typeof scope === 'string' ? [{ label: scope }] : Array.isArray(scope) ? scope : [scope as StageHeaderTag];
	return tags
		.filter((tag) => typeof tag?.label === 'string' && tag.label.trim() !== '')
		.map((tag) => ({ ...tag, label: tag.label.trim(), kind: tag.kind ?? 'scope' }));
}

function sameTags(a: readonly StageHeaderTag[], b: readonly StageHeaderTag[]): boolean {
	return a.length === b.length && a.every((tag, index) => tag.label === b[index].label && tag.kind === b[index].kind && tag.title === b[index].title);
}

function sameHeader(a: StageHeader, b: StageHeader): boolean {
	return a.view === b.view && a.title === b.title && a.status === b.status && a.actions === b.actions &&
		a.component === b.component && a.props === b.props && sameTags(a.scope, b.scope);
}

/** The store behind `stageHeader`, bound to a view source (tests pass their own). */
export function createStageHeaderStore(activeView: Readable<WorkspaceViewKey>) {
	const entries = writable<ReadonlyMap<string, Entry>>(new Map());
	let order = 0;

	function setStageHeader(owner: string, input: StageHeaderInput): void {
		if (!owner) return;
		const view = input.view ?? get(activeView);
		const header: StageHeader = {
			owner,
			view,
			title: String(input.title ?? ''),
			scope: normalizeScope(input.scope),
			status: input.status?.trim() ? input.status.trim() : null,
			actions: input.actions ?? NO_ACTIONS,
			component: input.component ?? null,
			props: input.props ?? NO_PROPS
		};
		const current = get(entries);
		const previous = current.get(owner);
		// Svelte stores notify on every object `set`, so an unchanged header must not set at all.
		if (previous && sameHeader(previous.header, header)) return;
		const next = new Map(current);
		// In place for the same view; a new owner (or a move to another view) goes on top.
		next.set(owner, { order: previous && previous.header.view === view ? previous.order : ++order, header });
		entries.set(next);
	}

	function clearStageHeader(owner: string): void {
		const current = get(entries);
		if (!current.has(owner)) return;
		const next = new Map(current);
		next.delete(owner);
		entries.set(next);
	}

	const stageHeader: Readable<StageHeader | null> = derived([entries, activeView], ([current, view]) => {
		let winner: Entry | null = null;
		for (const entry of current.values()) {
			if (entry.header.view === view && (!winner || entry.order > winner.order)) winner = entry;
		}
		return winner?.header ?? null;
	});

	return { stageHeader, setStageHeader, clearStageHeader };
}

const store = createStageHeaderStore(activeWorkspaceView);

/** Row A for the active workspace, or `null` when no owner describes it (StageBar defaults apply). */
export const stageHeader = store.stageHeader;
/** Describe row A for `owner`; see the module notes for ownership and ordering. */
export const setStageHeader = store.setStageHeader;
/** Remove `owner`'s header (call on destroy). Unknown owners are ignored. */
export const clearStageHeader = store.clearStageHeader;
