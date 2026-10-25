/**
 * dockClamp.ts
 * Center-stage guard for the companion panel (design contract §4.3, §8.4, §8.13).
 *
 * A companion is optional; the stage owns the task. A pinned panel sits in flow beside the stage
 * only while the stage keeps at least `minStage` px. Its width is the person's chosen width,
 * clamped to what is left over. When even `minPanel` px will not fit, the panel opens as a peek
 * instead: it floats over the stage's right edge at min(340px, 72% of the stage) and the stage
 * width does not change. (A committed pin with no room is kept but stowed off screen until the
 * stage has room again; see layoutStoreRightPanel.ts.)
 *
 * Pure: MainLayout measures the shell and feeds the numbers in; tests cover the breakpoints.
 */

export const DOCK_MIN_STAGE = 600;
export const DOCK_MIN_PANEL = 240;
export const DOCK_MAX_PANEL = 744;
export const DOCK_DEFAULT_PANEL = 304;
export const PEEK_MAX = 340;
export const PEEK_STAGE_RATIO = 0.72;

/** Keyboard steps for the resize separator (§7.21). */
export const DOCK_RESIZE_STEP = 16;
export const DOCK_RESIZE_STEP_LARGE = 64;

export type DockMode = 'pin' | 'peek';

export interface DockClampInput {
	/** Viewport (window) width in px. */
	viewport: number;
	/** Everything left of the stage that takes layout space: server rail + channel sidebar. */
	sidebar: number;
	/** The stub rail's reserved column (0 when the rail is hidden). */
	rail: number;
	/** The person's chosen panel width (layoutStore.rightPanelWidth). */
	requested: number;
	minStage?: number;
	minPanel?: number;
	maxPanel?: number;
}

export interface DockClamp {
	mode: DockMode;
	/** The width to render: the pinned width in 'pin' mode, the peek width in 'peek' mode. */
	width: number;
	/** The widest a pinned panel may be right now (for the separator's aria-valuemax). 0 in peek mode. */
	max: number;
}

function finite(value: number, fallback: number): number {
	return Number.isFinite(value) ? value : fallback;
}

/** The stage width left after the sidebar and rail, before any panel. */
export function stageWithoutPanel(input: Pick<DockClampInput, 'viewport' | 'sidebar' | 'rail'>): number {
	return Math.max(0, finite(input.viewport, 0) - Math.max(0, finite(input.sidebar, 0)) - Math.max(0, finite(input.rail, 0)));
}

/**
 * Peek width: min(340px, 72% of the stage). When the stage is so narrow that 72% would leave less
 * than a usable panel (a very wide sidebar), the peek keeps `minPanel` px, or whatever the window
 * has beside the rail, so it never collapses to an invisible sliver.
 */
export function peekWidthFor(stage: number, available = Number.POSITIVE_INFINITY, minPanel = DOCK_MIN_PANEL): number {
	const ratio = Math.max(0, finite(stage, 0)) * PEEK_STAGE_RATIO;
	const floor = Math.min(minPanel, Number.isNaN(available) ? 0 : Math.max(0, available));
	return Math.round(Math.min(PEEK_MAX, Math.max(ratio, floor)));
}

/**
 * Decide how a companion fits: `min(requested, viewport - sidebar - rail - minStage)`, pinned when
 * that is at least `minPanel`, otherwise a peek.
 */
export function dockWidthFor(input: DockClampInput): DockClamp {
	const minStage = input.minStage ?? DOCK_MIN_STAGE;
	const minPanel = input.minPanel ?? DOCK_MIN_PANEL;
	const maxPanel = input.maxPanel ?? DOCK_MAX_PANEL;
	const stage = stageWithoutPanel(input);
	const room = Math.floor(stage - minStage);
	if (room < minPanel) {
		const beside = finite(input.viewport, 0) - Math.max(0, finite(input.rail, 0));
		return { mode: 'peek', width: peekWidthFor(stage, beside, minPanel), max: 0 };
	}
	const max = Math.min(maxPanel, room);
	const requested = Math.round(finite(input.requested, DOCK_DEFAULT_PANEL));
	return { mode: 'pin', width: Math.min(max, Math.max(minPanel, requested)), max };
}

/**
 * The next pinned width for a separator key press, or null when the key does not resize.
 * `towardStage` is the arrow that widens the panel (ArrowLeft when the panel is on the right).
 */
export function resizeKeyWidth(
	key: string,
	current: number,
	opts: { shift: boolean; towardStage: 'ArrowLeft' | 'ArrowRight'; min?: number; max: number }
): number | null {
	const min = opts.min ?? DOCK_MIN_PANEL;
	const max = Math.max(min, opts.max);
	const step = opts.shift ? DOCK_RESIZE_STEP_LARGE : DOCK_RESIZE_STEP;
	const away = opts.towardStage === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft';
	let next: number;
	if (key === opts.towardStage) next = current + step;
	else if (key === away) next = current - step;
	else if (key === 'Home') next = min;
	else if (key === 'End') next = max;
	else return null;
	return Math.min(max, Math.max(min, Math.round(next)));
}
