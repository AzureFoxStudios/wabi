export {
	isValidWorkspacePanelId, normalizePanelId, uniqueValidPanelIds, clampSize,
	createTabset, clampPanelStackSize, createPanelStack, createDefaultPanelDock,
	normalizePanelDock, buildPhase1Root, isDockSide, findTabsetById
} from './layoutHelpers';

export {
	DEFAULT_NAV_SIZE, DEFAULT_AUX_SIZE, NAV_MIN_SIZE, NAV_MAX_SIZE,
	AUX_MIN_SIZE, AUX_MAX_SIZE, PANEL_STACK_MIN_SIZE, PANEL_STACK_MAX_SIZE,
	DEFAULT_PANEL_OVERFLOW_THRESHOLD, PANEL_ID_PATTERN, RESERVED_PANEL_IDS,
	TABSET_IDS, DEFAULT_WORKSPACE_PANEL_IDS, FALLBACK_WORKSPACE_PANEL_ID,
	MODULE_REGISTRY
} from './layoutConstants';

export type {
	DockModuleId, WorkspacePanelId, WorkspacePanelDockOrientation, ModuleRegistryEntry
} from './layoutConstants';

export const LAYOUT_VERSION = 1 as const;

export type LayoutVersion = typeof LAYOUT_VERSION;
export type DockZone = 'left' | 'center' | 'right';
export type DockDirection = 'horizontal' | 'vertical';
export type DockSide = 'left' | 'right';
export type WorkspacePreset = 'default' | 'classic' | 'focus' | 'media-review' | 'admin' | 'creator' | 'mod';

export interface WorkspacePanelStackV1 {
	id: string;
	tabs: WorkspacePanelId[];
	activePanelId: WorkspacePanelId;
	size: number;
	minSize: number;
	maxSize: number;
	collapsed: boolean;
	pinned: boolean;
}

export interface WorkspacePanelDockV1 {
	orientation: WorkspacePanelDockOrientation;
	stacks: WorkspacePanelStackV1[];
	overflowThreshold: number;
	updatedAt: number;
}

export interface DockTabsetNodeV1 {
	type: 'tabset';
	id: string;
	tabs: string[];
	activeTabId: string;
	size: number;
	minSize: number;
	maxSize: number;
	collapsed: boolean;
}

export interface DockSplitNodeV1 {
	type: 'split';
	id: string;
	direction: DockDirection;
	sizes: number[];
	children: DockNodeV1[];
}

export type DockNodeV1 = DockSplitNodeV1 | DockTabsetNodeV1;

export interface WorkspaceLayoutV1 {
	name: string;
	navDock: DockSide;
	root: DockSplitNodeV1;
	panelDock: WorkspacePanelDockV1;
	updatedAt: number;
}

export interface LayoutStateV1 {
	layoutVersion: LayoutVersion;
	activeWorkspace: string;
	workspaces: Record<string, WorkspaceLayoutV1>;
	updatedAt: number;
}

export interface DockActions {
	dock(moduleId: DockModuleId, zone: DockZone, position?: number): void;
	split(zone: DockZone, direction: DockDirection, ratio: number): void;
	tabify(moduleId: DockModuleId, targetTabsetId: string): void;
	collapse(zone: DockZone): void;
	reset(workspaceName?: string): void;
	saveWorkspace(name: string): void;
	loadWorkspace(name: string): void;
}

import {
	createDefaultPanelDock, normalizePanelDock, buildPhase1Root,
	findTabsetById, isDockSide, clampSize, normalizePanelId
} from './layoutHelpers';
import {
	DEFAULT_NAV_SIZE,
	DEFAULT_AUX_SIZE,
	NAV_MIN_SIZE,
	NAV_MAX_SIZE,
	AUX_MIN_SIZE,
	AUX_MAX_SIZE,
	TABSET_IDS,
	FALLBACK_WORKSPACE_PANEL_ID
} from './layoutConstants';
import type { DockModuleId, WorkspacePanelId, WorkspacePanelDockOrientation } from './layoutConstants';

function normalizeWorkspace(layout: Partial<WorkspaceLayoutV1>, nameFallback: string): WorkspaceLayoutV1 {
	const navDock = isDockSide(layout.navDock) ? layout.navDock : 'left';
	const root = layout.root;

	const fallback = createDefaultWorkspaceLayout(nameFallback);
	const navFallback = findTabsetById(fallback.root, TABSET_IDS.nav)!;
	const auxFallback = findTabsetById(fallback.root, TABSET_IDS.aux)!;

	const nav = root ? findTabsetById(root, TABSET_IDS.nav) : null;
	const aux = root ? findTabsetById(root, TABSET_IDS.aux) : null;

	return {
		name: layout.name || nameFallback,
		navDock,
		root: buildPhase1Root(
			navDock,
			nav ? nav.size : navFallback.size,
			nav ? !!nav.collapsed : navFallback.collapsed,
			aux ? aux.size : auxFallback.size,
			aux ? !!aux.collapsed : auxFallback.collapsed
		),
		panelDock: normalizePanelDock(layout.panelDock, nameFallback),
		updatedAt: typeof layout.updatedAt === 'number' ? layout.updatedAt : Date.now()
	};
}

function legacyToWorkspace(raw: Record<string, unknown>): WorkspaceLayoutV1 {
	const navDock = raw.navDock === 'right' ? 'right' : 'left';
	const channelSidebarWidth = clampSize(Number(raw.channelSidebarWidth || DEFAULT_NAV_SIZE), NAV_MIN_SIZE, NAV_MAX_SIZE);
	const rightPanelWidth = clampSize(Number(raw.rightPanelWidth || DEFAULT_AUX_SIZE), AUX_MIN_SIZE, AUX_MAX_SIZE);
	const rightPanelView = typeof raw.rightPanelView === 'string' ? raw.rightPanelView : 'none';
	const navCollapsed = Number(raw.channelSidebarWidth || DEFAULT_NAV_SIZE) <= 0;
	const auxCollapsed = rightPanelView === 'none' || Number(raw.rightPanelWidth || DEFAULT_AUX_SIZE) <= 0;
	const activePanelId = rightPanelView !== 'none' ? normalizePanelId(rightPanelView) : FALLBACK_WORKSPACE_PANEL_ID;

	return {
		name: 'default',
		navDock,
		root: buildPhase1Root(navDock, channelSidebarWidth, navCollapsed, rightPanelWidth, auxCollapsed),
		panelDock: createDefaultPanelDock('default', activePanelId),
		updatedAt: Date.now()
	};
}

export function createDefaultWorkspaceLayout(name: string): WorkspaceLayoutV1 {
	if (name === 'focus') {
		return {
			name,
			navDock: 'left',
			root: buildPhase1Root('left', 72, true, DEFAULT_AUX_SIZE, true),
			panelDock: createDefaultPanelDock('focus', 'dms'),
			updatedAt: Date.now()
		};
	}

	if (name === 'media-review') {
		return {
			name,
			navDock: 'left',
			root: buildPhase1Root('left', 240, false, 440, false),
			panelDock: createDefaultPanelDock('media-review', 'media'),
			updatedAt: Date.now()
		};
	}

	if (name === 'admin' || name === 'mod') {
		return {
			name,
			navDock: 'left',
			root: buildPhase1Root('left', 300, false, 460, false),
			panelDock: createDefaultPanelDock('admin', 'admin'),
			updatedAt: Date.now()
		};
	}

	if (name === 'creator') {
		return {
			name,
			navDock: 'left',
			root: buildPhase1Root('left', 280, false, 460, false),
			panelDock: createDefaultPanelDock('creator', 'media'),
			updatedAt: Date.now()
		};
	}

	return {
		name,
		navDock: 'left',
		root: buildPhase1Root('left', DEFAULT_NAV_SIZE, false, DEFAULT_AUX_SIZE, false),
		panelDock: createDefaultPanelDock(name === 'classic' ? 'classic' : 'default', 'users'),
		updatedAt: Date.now()
	};
}

export function createDefaultLayoutState(activeWorkspace = 'default'): LayoutStateV1 {
	const now = Date.now();
	const workspaces: Record<string, WorkspaceLayoutV1> = {
		default: createDefaultWorkspaceLayout('default'),
		classic: createDefaultWorkspaceLayout('classic'),
		focus: createDefaultWorkspaceLayout('focus'),
		'media-review': createDefaultWorkspaceLayout('media-review'),
		admin: createDefaultWorkspaceLayout('admin'),
		creator: createDefaultWorkspaceLayout('creator')
	};

	return {
		layoutVersion: LAYOUT_VERSION,
		activeWorkspace: workspaces[activeWorkspace] ? activeWorkspace : 'default',
		workspaces,
		updatedAt: now
	};
}

export function getWorkspace(state: LayoutStateV1): WorkspaceLayoutV1 {
	return state.workspaces[state.activeWorkspace] || createDefaultWorkspaceLayout('default');
}

export function withWorkspace(state: LayoutStateV1, workspace: WorkspaceLayoutV1): LayoutStateV1 {
	const normalized = normalizeWorkspace(workspace, workspace.name || 'default');
	return {
		...state,
		workspaces: {
			...state.workspaces,
			[normalized.name]: normalized
		},
		updatedAt: Date.now()
	};
}

export function migrateLayoutState(raw: unknown): LayoutStateV1 {
	if (!raw || typeof raw !== 'object') {
		return createDefaultLayoutState();
	}

	const candidate = raw as Partial<LayoutStateV1> & Record<string, unknown>;
	if (candidate.layoutVersion === LAYOUT_VERSION && candidate.workspaces && typeof candidate.workspaces === 'object') {
		const workspaces: Record<string, WorkspaceLayoutV1> = {};
		for (const [name, workspace] of Object.entries(candidate.workspaces)) {
			workspaces[name] = normalizeWorkspace(workspace as WorkspaceLayoutV1, name);
		}

		if (!workspaces.default) {
			workspaces.default = createDefaultWorkspaceLayout('default');
		}
		for (const preset of ['classic', 'focus', 'media-review', 'admin', 'creator']) {
			if (!workspaces[preset]) {
				workspaces[preset] = createDefaultWorkspaceLayout(preset);
			}
		}

		return {
			layoutVersion: LAYOUT_VERSION,
			activeWorkspace:
				typeof candidate.activeWorkspace === 'string' && workspaces[candidate.activeWorkspace]
					? candidate.activeWorkspace
					: 'default',
			workspaces,
			updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now()
		};
	}

	if ('channelSidebarWidth' in candidate || 'rightPanelWidth' in candidate || 'rightPanelView' in candidate) {
		const state = createDefaultLayoutState('default');
		state.workspaces.default = legacyToWorkspace(candidate);
		return state;
	}

	return createDefaultLayoutState();
}

export function serializeLayoutState(state: LayoutStateV1): string {
	return JSON.stringify(migrateLayoutState(state));
}

export function deserializeLayoutState(serialized: string | null | undefined): LayoutStateV1 {
	if (!serialized) return createDefaultLayoutState();
	try {
		const parsed = JSON.parse(serialized);
		return migrateLayoutState(parsed);
	} catch {
		return createDefaultLayoutState();
	}
}

export function cloneWorkspace(workspace: WorkspaceLayoutV1, nextName: string): WorkspaceLayoutV1 {
	return normalizeWorkspace(
		{
			...workspace,
			name: nextName,
			root: JSON.parse(JSON.stringify(workspace.root))
		},
		nextName
	);
}

export function getNavTabset(workspace: WorkspaceLayoutV1): DockTabsetNodeV1 {
	const existing = findTabsetById(workspace.root, TABSET_IDS.nav);
	if (existing) return existing;
	return findTabsetById(createDefaultWorkspaceLayout(workspace.name).root, TABSET_IDS.nav)!;
}

export function getAuxTabset(workspace: WorkspaceLayoutV1): DockTabsetNodeV1 {
	const existing = findTabsetById(workspace.root, TABSET_IDS.aux);
	if (existing) return existing;
	return findTabsetById(createDefaultWorkspaceLayout(workspace.name).root, TABSET_IDS.aux)!;
}
