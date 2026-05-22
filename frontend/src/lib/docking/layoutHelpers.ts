import {
	DEFAULT_WORKSPACE_PANEL_IDS,
	FALLBACK_WORKSPACE_PANEL_ID,
	PANEL_ID_PATTERN,
	RESERVED_PANEL_IDS,
	PANEL_STACK_MIN_SIZE,
	PANEL_STACK_MAX_SIZE,
	DEFAULT_PANEL_OVERFLOW_THRESHOLD,
	NAV_MIN_SIZE,
	NAV_MAX_SIZE,
	AUX_MIN_SIZE,
	AUX_MAX_SIZE,
	TABSET_IDS,
	type DockSide,
	type DockModuleId,
	type WorkspacePanelId,
	type WorkspacePanelDockOrientation,
	type DockTabsetNodeV1,
	type DockSplitNodeV1,
	type WorkspacePanelStackV1,
	type WorkspacePanelDockV1,
	type WorkspaceLayoutV1,
	type WorkspacePreset
} from './layoutSchema';

export function isValidWorkspacePanelId(value: unknown): value is WorkspacePanelId {
	if (typeof value !== 'string') return false;
	const trimmed = value.trim();
	if (!trimmed || RESERVED_PANEL_IDS.has(trimmed)) return false;
	return PANEL_ID_PATTERN.test(trimmed);
}

export function normalizePanelId(value: unknown, fallback: WorkspacePanelId = FALLBACK_WORKSPACE_PANEL_ID): WorkspacePanelId {
	if (isValidWorkspacePanelId(value)) return value.trim();
	return fallback;
}

export function uniqueValidPanelIds(value: unknown, fallback: WorkspacePanelId[] = [...DEFAULT_WORKSPACE_PANEL_IDS]): WorkspacePanelId[] {
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

export function clampSize(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.round(value)));
}

export function createTabset(
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

export function clampPanelStackSize(value: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(PANEL_STACK_MAX_SIZE, Math.max(PANEL_STACK_MIN_SIZE, Math.round(value)));
}

export function createPanelStack(
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

export function isDockSide(value: unknown): value is DockSide {
	return value === 'left' || value === 'right';
}

export function findTabsetById(root: DockSplitNodeV1, id: string): DockTabsetNodeV1 | null {
	for (const child of root.children) {
		if (child.type === 'tabset' && child.id === id) {
			return child;
		}
	}
	return null;
}
