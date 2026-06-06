import { browser } from '$app/environment';
import { derived, get, writable } from 'svelte/store';
import { clampRectToViewport, createDefaultRect, getCascadeOffset, getSnapRect } from './snapMath';
import type { FloatingPanelOptions, FloatingPanelState, Rect, SnapZone } from './types';

const MIN_WIDTH = 320;
const MIN_HEIGHT = 240;
const BASE_Z_INDEX = 1200;

interface FloatingPanelStoreState {
	panels: FloatingPanelState[];
	focusedPanelId: string | null;
	ghostRect: Rect | null;
	ghostVisible: boolean;
}

function generateId(kind: string, payload?: FloatingPanelOptions['payload']): string {
	const stableKey = payload?.channelId || payload?.panelId || payload?.placeId;
	if (stableKey) return `${kind}-${stableKey}`.replace(/[^a-zA-Z0-9_-]/g, '-');
	return `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function getViewportRect(): Rect {
	if (!browser) return { x: 0, y: 0, width: 1280, height: 800 };
	return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
}

function getNextZIndex(state: FloatingPanelStoreState): number {
	return state.panels.length === 0 ? BASE_Z_INDEX : Math.max(...state.panels.map((panel) => panel.zIndex)) + 1;
}

function resolveRect(options: FloatingPanelOptions, panelCount: number): Rect {
	const viewport = getViewportRect();
	const defaultRect = createDefaultRect(viewport);
	const offset = getCascadeOffset(panelCount % 8);
	const requested = options.rect || {};
	return clampRectToViewport(
		{
			x: requested.x ?? defaultRect.x + offset,
			y: requested.y ?? defaultRect.y + offset,
			width: requested.width ?? defaultRect.width,
			height: requested.height ?? defaultRect.height
		},
		viewport,
		MIN_WIDTH,
		MIN_HEIGHT
	);
}

function getDefaultTitle(kind: FloatingPanelState['kind'], payload: FloatingPanelState['payload']): string {
	switch (kind) {
		case 'channel-chat':
			return payload.channelName ? `#${payload.channelName}` : 'Channel';
		case 'server-map':
			return 'Map';
		case 'workspace-panel':
			return payload.panelId || 'Panel';
		default:
			return 'Panel';
	}
}

function createFloatingPanelStore() {
	const { subscribe, update } = writable<FloatingPanelStoreState>({
		panels: [],
		focusedPanelId: null,
		ghostRect: null,
		ghostVisible: false
	});

	function openFloatingPanel(options: FloatingPanelOptions): string {
		let openedId = '';
		update((state) => {
			const id = generateId(options.kind, options.payload);
			openedId = id;
			const existing = state.panels.find((panel) => panel.id === id);
			if (existing) {
				const zIndex = getNextZIndex(state);
				return {
					...state,
					focusedPanelId: id,
					panels: state.panels.map((panel) => panel.id === id ? { ...panel, zIndex } : panel)
				};
			}
			const panel: FloatingPanelState = {
				id,
				kind: options.kind,
				title: options.title || getDefaultTitle(options.kind, options.payload || {}),
				payload: options.payload || {},
				mode: 'floating',
				rect: resolveRect(options, state.panels.length),
				zIndex: getNextZIndex(state)
			};
			return { ...state, panels: [...state.panels, panel], focusedPanelId: id };
		});
		return openedId;
	}

	function closeFloatingPanel(id: string): void {
		update((state) => {
			const panels = state.panels.filter((panel) => panel.id !== id);
			const focusedPanelId = state.focusedPanelId === id ? panels.at(-1)?.id ?? null : state.focusedPanelId;
			return { ...state, panels, focusedPanelId };
		});
	}

	function focusFloatingPanel(id: string): void {
		update((state) => {
			if (!state.panels.some((panel) => panel.id === id)) return state;
			const zIndex = getNextZIndex(state);
			return {
				...state,
				focusedPanelId: id,
				panels: state.panels.map((panel) => panel.id === id ? { ...panel, zIndex } : panel)
			};
		});
	}

	function moveFloatingPanel(id: string, rect: Rect): void {
		update((state) => ({
			...state,
			panels: state.panels.map((panel) =>
				panel.id === id
					? { ...panel, rect: clampRectToViewport(rect, getViewportRect(), MIN_WIDTH, MIN_HEIGHT), mode: 'floating', snapZone: undefined }
					: panel
			)
		}));
	}

	function resizeFloatingPanel(id: string, rect: Rect): void {
		update((state) => ({
			...state,
			panels: state.panels.map((panel) =>
				panel.id === id ? { ...panel, rect: clampRectToViewport(rect, getViewportRect(), MIN_WIDTH, MIN_HEIGHT) } : panel
			)
		}));
	}

	function snapFloatingPanel(id: string, zone: SnapZone, viewport: Rect = getViewportRect()): void {
		update((state) => ({
			...state,
			panels: state.panels.map((panel) =>
				panel.id === id
					? {
							...panel,
							previousRect: panel.mode === 'floating' ? panel.rect : panel.previousRect,
							rect: getSnapRect(zone, viewport),
							mode: zone === 'maximize' ? 'maximized' : 'docked',
							snapZone: zone
						}
					: panel
			)
		}));
	}

	function restoreFloatingPanel(id: string): void {
		update((state) => ({
			...state,
			panels: state.panels.map((panel) =>
				panel.id === id && panel.previousRect
					? { ...panel, rect: panel.previousRect, previousRect: undefined, mode: 'floating', snapZone: undefined }
					: panel
			)
		}));
	}

	function showGhost(rect: Rect | null): void {
		update((state) => ({ ...state, ghostRect: rect, ghostVisible: Boolean(rect) }));
	}

	function hideGhost(): void {
		update((state) => ({ ...state, ghostRect: null, ghostVisible: false }));
	}

	function getPanel(id: string): FloatingPanelState | undefined {
		return get({ subscribe }).panels.find((panel) => panel.id === id);
	}

	return {
		subscribe,
		openFloatingPanel,
		closeFloatingPanel,
		focusFloatingPanel,
		moveFloatingPanel,
		resizeFloatingPanel,
		snapFloatingPanel,
		restoreFloatingPanel,
		showGhost,
		hideGhost,
		getPanel
	};
}

export const floatingPanelStore = createFloatingPanelStore();
export const panels = derived(floatingPanelStore, ($store) => $store.panels);
export const focusedPanelId = derived(floatingPanelStore, ($store) => $store.focusedPanelId);
export const ghostRect = derived(floatingPanelStore, ($store) => $store.ghostRect);
export const ghostVisible = derived(floatingPanelStore, ($store) => $store.ghostVisible);
