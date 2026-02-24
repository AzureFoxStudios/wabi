export const LAYOUT_VERSION = 1 as const;

export type LayoutVersion = typeof LAYOUT_VERSION;
export type DockZone = 'left' | 'center' | 'right';
export type DockDirection = 'horizontal' | 'vertical';
export type DockSide = 'left' | 'right';
export type WorkspacePreset = 'default' | 'focus' | 'mod';
export type DockModuleId =
	| 'gate-switcher'
	| 'nav'
	| 'content'
	| 'right-panel'
	| 'members'
	| 'media'
	| 'calls'
	| 'inspector'
	| 'settings';

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
	updatedAt: number;
}

export interface LayoutStateV1 {
	layoutVersion: LayoutVersion;
	activeWorkspace: string;
	workspaces: Record<string, WorkspaceLayoutV1>;
	updatedAt: number;
}

export interface ModuleRegistryEntry {
	id: DockModuleId;
	title: string;
	icon?: string;
	render?: unknown;
	defaultDock: DockZone;
	constraints?: {
		canClose?: boolean;
		canTab?: boolean;
		canSplit?: boolean;
		minSize?: number;
	};
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

const DEFAULT_NAV_SIZE = 280;
const DEFAULT_AUX_SIZE = 320;
const NAV_MIN_SIZE = 60;
const NAV_MAX_SIZE = 420;
const AUX_MIN_SIZE = 220;
const AUX_MAX_SIZE = 520;

const TABSET_IDS = {
	nav: 'tabset-nav',
	content: 'tabset-content',
	aux: 'tabset-aux'
} as const;

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

function clampSize(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.round(value)));
}

function createTabset(
	id: string,
	tabs: string[],
	activeTabId: string,
	size: number,
	minSize: number,
	maxSize: number,
	collapsed: boolean
): DockTabsetNodeV1 {
	return {
		type: 'tabset',
		id,
		tabs,
		activeTabId,
		size: clampSize(size, minSize, maxSize),
		minSize,
		maxSize,
		collapsed
	};
}

export function buildPhase1Root(
	navDock: DockSide,
	navSize: number,
	navCollapsed: boolean,
	auxSize: number,
	auxCollapsed: boolean
): DockSplitNodeV1 {
	const nav = createTabset(
		TABSET_IDS.nav,
		['gate-switcher', 'nav'],
		'nav',
		navSize,
		NAV_MIN_SIZE,
		NAV_MAX_SIZE,
		navCollapsed
	);

	const content = createTabset(
		TABSET_IDS.content,
		['content'],
		'content',
		1,
		1,
		1,
		false
	);

	const aux = createTabset(
		TABSET_IDS.aux,
		['right-panel'],
		'right-panel',
		auxSize,
		AUX_MIN_SIZE,
		AUX_MAX_SIZE,
		auxCollapsed
	);

	if (navDock === 'right') {
		return {
			type: 'split',
			id: 'root-split',
			direction: 'horizontal',
			sizes: [aux.collapsed ? 0 : aux.size, 1, nav.collapsed ? 0 : nav.size],
			children: [aux, content, nav]
		};
	}

	return {
		type: 'split',
		id: 'root-split',
		direction: 'horizontal',
		sizes: [nav.collapsed ? 0 : nav.size, 1, aux.collapsed ? 0 : aux.size],
		children: [nav, content, aux]
	};
}

function isDockSide(value: unknown): value is DockSide {
	return value === 'left' || value === 'right';
}

function findTabsetById(root: DockSplitNodeV1, id: string): DockTabsetNodeV1 | null {
	for (const child of root.children) {
		if (child.type === 'tabset' && child.id === id) {
			return child;
		}
	}
	return null;
}

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

	return {
		name: 'default',
		navDock,
		root: buildPhase1Root(navDock, channelSidebarWidth, navCollapsed, rightPanelWidth, auxCollapsed),
		updatedAt: Date.now()
	};
}

export function createDefaultWorkspaceLayout(name: string): WorkspaceLayoutV1 {
	if (name === 'focus') {
		return {
			name,
			navDock: 'left',
			root: buildPhase1Root('left', 72, true, DEFAULT_AUX_SIZE, true),
			updatedAt: Date.now()
		};
	}

	if (name === 'mod') {
		return {
			name,
			navDock: 'left',
			root: buildPhase1Root('left', 280, false, 360, false),
			updatedAt: Date.now()
		};
	}

	return {
		name,
		navDock: 'left',
		root: buildPhase1Root('left', DEFAULT_NAV_SIZE, false, DEFAULT_AUX_SIZE, true),
		updatedAt: Date.now()
	};
}

export function createDefaultLayoutState(activeWorkspace = 'default'): LayoutStateV1 {
	const now = Date.now();
	const workspaces: Record<string, WorkspaceLayoutV1> = {
		default: createDefaultWorkspaceLayout('default'),
		focus: createDefaultWorkspaceLayout('focus'),
		mod: createDefaultWorkspaceLayout('mod')
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

	// Legacy conversion path (layoutStore pre-docking fields).
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
