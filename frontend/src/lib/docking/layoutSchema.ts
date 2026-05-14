export const LAYOUT_VERSION = 1 as const;

export type LayoutVersion = typeof LAYOUT_VERSION;
export type DockZone = 'left' | 'center' | 'right';
export type DockDirection = 'horizontal' | 'vertical';
export type DockSide = 'left' | 'right';
export type WorkspacePreset = 'default' | 'classic' | 'focus' | 'media-review' | 'admin' | 'creator' | 'mod';
export type DockModuleId = string;
export type WorkspacePanelId = string;
export type WorkspacePanelDockOrientation = 'vertical' | 'horizontal';

export const DEFAULT_WORKSPACE_PANEL_IDS = ['users', 'dms', 'notes', 'map', 'media', 'admin'] as const;
export const FALLBACK_WORKSPACE_PANEL_ID = DEFAULT_WORKSPACE_PANEL_IDS[0];

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
const DEFAULT_AUX_SIZE = 360;
const NAV_MIN_SIZE = 60;
const NAV_MAX_SIZE = 1200;
const AUX_MIN_SIZE = 22;
const AUX_MAX_SIZE = 1200;
const PANEL_STACK_MIN_SIZE = 22;
const PANEL_STACK_MAX_SIZE = 100;
const DEFAULT_PANEL_OVERFLOW_THRESHOLD = 5;
const PANEL_ID_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,79}$/i;
const RESERVED_PANEL_IDS = new Set(['__proto__', 'constructor', 'prototype']);

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

export function isValidWorkspacePanelId(value: unknown): value is WorkspacePanelId {
	if (typeof value !== 'string') return false;
	const trimmed = value.trim();
	if (!trimmed || RESERVED_PANEL_IDS.has(trimmed)) return false;
	return PANEL_ID_PATTERN.test(trimmed);
}

function normalizePanelId(value: unknown, fallback: WorkspacePanelId = FALLBACK_WORKSPACE_PANEL_ID): WorkspacePanelId {
	if (isValidWorkspacePanelId(value)) return value.trim();
	return fallback;
}

function uniqueValidPanelIds(value: unknown, fallback: WorkspacePanelId[] = [...DEFAULT_WORKSPACE_PANEL_IDS]): WorkspacePanelId[] {
	const source = Array.isArray(value) ? value : fallback;
	const seen = new Set<string>();
	const tabs: WorkspacePanelId[] = [];
	for (const rawId of source) {
		if (!isValidWorkspacePanelId(rawId)) continue;
		const id = rawId.trim();
		if (seen.has(id)) continue;
		seen.add(id);
		tabs.push(id);
	}
	return tabs.length > 0 ? tabs : [...fallback];
}

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

function clampPanelStackSize(value: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(PANEL_STACK_MAX_SIZE, Math.max(PANEL_STACK_MIN_SIZE, Math.round(value)));
}

function createPanelStack(
	id: string,
	tabs: WorkspacePanelId[],
	activePanelId: WorkspacePanelId,
	size: number,
	collapsed = false,
	pinned = true
): WorkspacePanelStackV1 {
	const normalizedTabs = uniqueValidPanelIds(tabs);
	const normalizedActive = normalizedTabs.includes(activePanelId) ? activePanelId : normalizedTabs[0];
	return {
		id,
		tabs: normalizedTabs,
		activePanelId: normalizedActive,
		size: clampPanelStackSize(size, size),
		minSize: PANEL_STACK_MIN_SIZE,
		maxSize: PANEL_STACK_MAX_SIZE,
		collapsed,
		pinned
	};
}

export function createDefaultPanelDock(preset: WorkspacePreset | string = 'default', activePanelId?: WorkspacePanelId): WorkspacePanelDockV1 {
	const active = normalizePanelId(activePanelId, FALLBACK_WORKSPACE_PANEL_ID);
	const baseTabs = [...DEFAULT_WORKSPACE_PANEL_IDS];
	const activeFirstTabs = [active, ...baseTabs.filter((id) => id !== active)];
	const now = Date.now();

	if (preset === 'media-review') {
		return {
			orientation: 'vertical',
			stacks: [
				createPanelStack('stack-primary', ['media', 'map', 'notes'], active === 'map' ? 'map' : 'media', 58),
				createPanelStack('stack-secondary', ['users', 'dms', 'admin'], active === 'dms' ? 'dms' : 'users', 42)
			],
			overflowThreshold: DEFAULT_PANEL_OVERFLOW_THRESHOLD,
			updatedAt: now
		};
	}

	if (preset === 'admin' || preset === 'mod') {
		return {
			orientation: 'vertical',
			stacks: [
				createPanelStack('stack-primary', ['admin', 'users', 'map'], active === 'map' || active === 'users' ? active : 'admin', 56),
				createPanelStack('stack-secondary', ['dms', 'notes', 'media'], active === 'media' || active === 'notes' ? active : 'dms', 44)
			],
			overflowThreshold: DEFAULT_PANEL_OVERFLOW_THRESHOLD,
			updatedAt: now
		};
	}

	if (preset === 'creator') {
		return {
			orientation: 'vertical',
			stacks: [
				createPanelStack('stack-primary', ['media', 'map', 'notes'], active === 'map' || active === 'notes' ? active : 'media', 60),
				createPanelStack('stack-secondary', ['dms', 'users', 'admin'], active === 'users' || active === 'admin' ? active : 'dms', 40)
			],
			overflowThreshold: DEFAULT_PANEL_OVERFLOW_THRESHOLD,
			updatedAt: now
		};
	}

	return {
		orientation: 'vertical',
		stacks: [createPanelStack('stack-primary', activeFirstTabs, active, 100)],
		overflowThreshold: DEFAULT_PANEL_OVERFLOW_THRESHOLD,
		updatedAt: now
	};
}

export function normalizePanelDock(value: unknown, preset: WorkspacePreset | string = 'default'): WorkspacePanelDockV1 {
	if (!value || typeof value !== 'object') {
		return createDefaultPanelDock(preset);
	}

	const raw = value as Partial<WorkspacePanelDockV1> & Record<string, unknown>;
	const orientation = raw.orientation === 'horizontal' ? 'horizontal' : 'vertical';
	const stacksSource = Array.isArray(raw.stacks) ? raw.stacks : [];
	const stacks: WorkspacePanelStackV1[] = [];
	const globalSeen = new Set<string>();

	for (const [index, stackValue] of stacksSource.entries()) {
		if (!stackValue || typeof stackValue !== 'object') continue;
		const stack = stackValue as Partial<WorkspacePanelStackV1> & Record<string, unknown>;
		const rawTabs = uniqueValidPanelIds(stack.tabs, index === 0 ? [...DEFAULT_WORKSPACE_PANEL_IDS] : []);
		const tabs = rawTabs.filter((id) => {
			if (globalSeen.has(id)) return false;
			globalSeen.add(id);
			return true;
		});
		if (tabs.length === 0) continue;
		const activePanelId = normalizePanelId(stack.activePanelId, tabs[0]);
		stacks.push({
			id: typeof stack.id === 'string' && stack.id.trim() ? stack.id.trim() : `stack-${index + 1}`,
			tabs,
			activePanelId: tabs.includes(activePanelId) ? activePanelId : tabs[0],
			size: clampPanelStackSize(Number(stack.size), stacks.length === 0 ? 60 : 40),
			minSize: PANEL_STACK_MIN_SIZE,
			maxSize: PANEL_STACK_MAX_SIZE,
			collapsed: Boolean(stack.collapsed),
			pinned: stack.pinned !== false
		});
		if (stacks.length >= 2) break;
	}

	if (stacks.length === 0) {
		return createDefaultPanelDock(preset);
	}

	const missingDefaultTabs = DEFAULT_WORKSPACE_PANEL_IDS.filter((id) => !globalSeen.has(id));
	if (missingDefaultTabs.length > 0) {
		stacks[0] = {
			...stacks[0],
			tabs: [...stacks[0].tabs, ...missingDefaultTabs]
		};
	}

	if (stacks.length === 1) {
		stacks[0] = { ...stacks[0], size: 100 };
	} else {
		const total = stacks.reduce((sum, stack) => sum + (stack.collapsed ? 0 : stack.size), 0);
		if (total > 0) {
			stacks[0] = { ...stacks[0], size: clampPanelStackSize((stacks[0].size / total) * 100, 60) };
			stacks[1] = { ...stacks[1], size: clampPanelStackSize(100 - stacks[0].size, 40) };
		}
	}

	return {
		orientation,
		stacks,
		overflowThreshold: clampSize(Number(raw.overflowThreshold || DEFAULT_PANEL_OVERFLOW_THRESHOLD), 3, 8),
		updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now()
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
