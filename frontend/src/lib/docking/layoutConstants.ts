export const DEFAULT_NAV_SIZE = 280;
export const DEFAULT_AUX_SIZE = 360;
export const NAV_MIN_SIZE = 60;
export const NAV_MAX_SIZE = 1200;
export const AUX_MIN_SIZE = 22;
export const AUX_MAX_SIZE = 1200;
export const PANEL_STACK_MIN_SIZE = 22;
export const PANEL_STACK_MAX_SIZE = 100;
export const DEFAULT_PANEL_OVERFLOW_THRESHOLD = 4;
export const PANEL_ID_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,79}$/i;
export const RESERVED_PANEL_IDS = new Set(['__proto__', 'constructor', 'prototype']);

export const TABSET_IDS = {
	nav: 'tabset-nav',
	content: 'tabset-content',
	aux: 'tabset-aux'
} as const;

// Calm ambient strip comes first (users, dms, notes, map). Heavier tools
// (media, transfers, admin) fall behind the overflow row by default.
export const DEFAULT_WORKSPACE_PANEL_IDS = ['users', 'dms', 'notes', 'whiteboard-layers', 'map', 'media', 'transfers', 'admin'] as const;
export const FALLBACK_WORKSPACE_PANEL_ID = DEFAULT_WORKSPACE_PANEL_IDS[0];

export type DockModuleId = string;
export type WorkspacePanelId = string;
export type WorkspacePanelDockOrientation = 'vertical' | 'horizontal';

export interface ModuleRegistryEntry {
	id: DockModuleId;
	title: string;
	icon?: string;
	render?: unknown;
	defaultDock: 'left' | 'center' | 'right';
	constraints?: {
		canClose?: boolean;
		canTab?: boolean;
		canSplit?: boolean;
		minSize?: number;
	};
}

export const MODULE_REGISTRY: Record<DockModuleId, ModuleRegistryEntry> = {
	'gate-switcher': {
		id: 'gate-switcher',
		title: 'Gate Switcher',
		defaultDock: 'left',
		constraints: { canClose: false, minSize: 56 }
	},
	nav: {
		id: 'nav',
		title: 'Navigation',
		defaultDock: 'left',
		constraints: { canClose: false, minSize: NAV_MIN_SIZE }
	},
	content: {
		id: 'content',
		title: 'Content',
		defaultDock: 'center',
		constraints: { canClose: false, canSplit: true }
	},
	'right-panel': {
		id: 'right-panel',
		title: 'People / DMs',
		defaultDock: 'right',
		constraints: { canClose: true, minSize: AUX_MIN_SIZE }
	},
	members: { id: 'members', title: 'Members', defaultDock: 'right' },
	media: { id: 'media', title: 'Media', defaultDock: 'right' },
	calls: { id: 'calls', title: 'Calls', defaultDock: 'right' },
	inspector: { id: 'inspector', title: 'Inspector', defaultDock: 'right' },
	settings: { id: 'settings', title: 'Settings', defaultDock: 'right' }
};
