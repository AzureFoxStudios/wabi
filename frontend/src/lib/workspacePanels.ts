import { derived, get, writable } from 'svelte/store';
import { brandName } from '$lib/branding';
import type { User } from '$lib/socket-types';
import {
	DEFAULT_WORKSPACE_PANEL_IDS,
	FALLBACK_WORKSPACE_PANEL_ID,
	isValidWorkspacePanelId,
	type WorkspacePanelId
} from '$lib/docking/layoutSchema';

export type WorkspacePanelIcon =
	| 'users'
	| 'messages'
	| 'notes'
	| 'layers'
	| 'map'
	| 'media'
	| 'admin'
	| 'box'
	| 'activity'
	| 'tasks'
	| 'settings'
	| 'transfers'
	| 'headphones';

export type WorkspacePanelComponentKey =
	| 'users'
	| 'dms'
	| 'notes'
	| 'whiteboard-layers'
	| 'map'
	| 'media'
	| 'admin'
	| 'addon-fallback'
	| 'model-viewport'
	| 'ffxiv-reference'
	| 'reader'
	| 'transfers'
	| 'code'
	| 'planner-tasks'
	| 'calls';

export type WorkspacePanelDockArea = 'right' | 'bottom' | 'center' | 'floating';
export type WorkspacePanelMobileMode = 'sheet' | 'fullscreen' | 'hidden';

export interface WorkspacePanelFallbackBehavior {
	title?: string;
	message?: string;
	actionLabel?: string;
	settingsRoute?: string;
}

export interface WorkspacePanelManifest {
	id: WorkspacePanelId;
	label: string;
	shortLabel?: string;
	icon: WorkspacePanelIcon;
	component: WorkspacePanelComponentKey;
	capabilities?: string[];
	defaultDock: WorkspacePanelDockArea;
	preferredDockArea?: WorkspacePanelDockArea;
	mobileMode: WorkspacePanelMobileMode;
	badge?: number | string | null;
	permissions?: string[];
	settingsRoute?: string;
	pluginId?: string;
	source: 'core' | 'addon';
	fallbackBehavior?: WorkspacePanelFallbackBehavior;
	sortOrder?: number;
}

export interface PluginWorkspacePanelDeclaration {
	id?: string;
	label?: string;
	shortLabel?: string;
	icon?: WorkspacePanelIcon;
	component?: string;
	capabilities?: string[];
	defaultDock?: WorkspacePanelDockArea;
	preferredDockArea?: WorkspacePanelDockArea;
	mobileMode?: WorkspacePanelMobileMode;
	badge?: number | string | null;
	permissions?: string[];
	settingsRoute?: string;
	fallbackBehavior?: WorkspacePanelFallbackBehavior;
	sortOrder?: number;
}

export interface WorkspacePanelPluginRecord {
	id?: string;
	name?: string;
	frontendExtensions?: {
		workspacePanels?: PluginWorkspacePanelDeclaration[];
		mobileTabs?: PluginWorkspacePanelDeclaration[];
		settingsPages?: Array<{ id?: string; label?: string; route?: string; permissions?: string[] }>;
	};
	workspacePanels?: PluginWorkspacePanelDeclaration[];
	permissions?: string[];
}

export const BUILTIN_WORKSPACE_PANELS: WorkspacePanelManifest[] = [
	{
		id: 'calls',
		label: 'Calls',
		icon: 'headphones',
		component: 'calls',
		capabilities: ['per-call-volume', 'focus-switch', 'hang-up'],
		defaultDock: 'right',
		mobileMode: 'sheet',
		source: 'core',
		sortOrder: 5
	},
	{
		id: 'users',
		label: 'People',
		icon: 'users',
		component: 'users',
		capabilities: ['search', 'profile-actions', 'quick-dm'],
		defaultDock: 'right',
		mobileMode: 'sheet',
		source: 'core',
		sortOrder: 10
	},
	{
		id: 'dms',
		label: 'Messages',
		shortLabel: 'DMs',
		icon: 'messages',
		component: 'dms',
		capabilities: ['compose', 'payments', 'notes-entry'],
		defaultDock: 'right',
		mobileMode: 'fullscreen',
		source: 'core',
		sortOrder: 20
	},
	{
		id: 'notes',
		label: 'Notes',
		icon: 'notes',
		component: 'notes',
		capabilities: ['scratchpad', 'local-persistence'],
		defaultDock: 'bottom',
		mobileMode: 'sheet',
		source: 'core',
		sortOrder: 30
	},
	{
		id: 'whiteboard-layers',
		label: 'Whiteboard Layers',
		shortLabel: 'Layers',
		icon: 'layers',
		component: 'whiteboard-layers',
		capabilities: ['whiteboard', 'layers'],
		defaultDock: 'right',
		mobileMode: 'sheet',
		source: 'core',
		sortOrder: 35
	},
	{
		id: 'map',
		label: 'Map',
		icon: 'map',
		component: 'map',
		capabilities: ['places', 'directions', 'shared-context'],
		defaultDock: 'right',
		mobileMode: 'fullscreen',
		source: 'core',
		sortOrder: 40
	},
	{
		id: 'media',
		label: 'Media',
		icon: 'media',
		component: 'media',
		capabilities: ['albums', 'lightbox', 'review'],
		defaultDock: 'right',
		mobileMode: 'fullscreen',
		source: 'core',
		sortOrder: 50
	},
	{
		id: 'admin',
		label: 'Admin',
		icon: 'admin',
		component: 'admin',
		capabilities: ['moderation', 'roles', 'server-controls'],
		defaultDock: 'right',
		mobileMode: 'fullscreen',
		permissions: ['mod'],
		source: 'core',
		sortOrder: 60
	},
	{
		id: 'transfers',
		label: 'Transfers',
		shortLabel: 'Xfers',
		icon: 'transfers',
		component: 'transfers',
		capabilities: ['p2p-file-transfer', 'transfer-queue'],
		defaultDock: 'right',
		mobileMode: 'fullscreen',
		source: 'core',
		sortOrder: 55
	},
	{
		id: 'code',
		label: 'Project',
		shortLabel: 'Project',
		icon: 'box',
		component: 'code',
		capabilities: ['repo-browse'],
		defaultDock: 'right',
		mobileMode: 'sheet',
		source: 'core',
		sortOrder: 56
	},
	{
		id: 'planner-tasks',
		label: 'Tasks',
		shortLabel: 'Tasks',
		icon: 'tasks',
		component: 'planner-tasks',
		capabilities: ['planner', 'todo-list'],
		defaultDock: 'right',
		mobileMode: 'sheet',
		source: 'core',
		sortOrder: 57
	}
];

const panelRegistry = writable<Record<WorkspacePanelId, WorkspacePanelManifest>>(
	Object.fromEntries(BUILTIN_WORKSPACE_PANELS.map((panel) => [panel.id, panel]))
);
const KNOWN_COMPONENT_KEYS = new Set<WorkspacePanelComponentKey>([
	'users',
	'dms',
	'notes',
	'whiteboard-layers',
	'map',
	'media',
	'admin',
	'addon-fallback',
	'model-viewport',
	'ffxiv-reference',
	'reader',
	'transfers',
	'code',
	'planner-tasks'
]);

export const workspacePanelRegistry = { subscribe: panelRegistry.subscribe };

export const workspacePanelList = derived(panelRegistry, ($panelRegistry) =>
	Object.values($panelRegistry).sort((a, b) => (a.sortOrder ?? 500) - (b.sortOrder ?? 500) || a.label.localeCompare(b.label))
);

export function getWorkspacePanelManifest(panelId: WorkspacePanelId): WorkspacePanelManifest | null {
	return get(panelRegistry)[panelId] || null;
}

export function getWorkspacePanelManifests(panelIds: WorkspacePanelId[]): WorkspacePanelManifest[] {
	const registry = get(panelRegistry);
	return panelIds
		.map((panelId) => registry[panelId])
		.filter((panel): panel is WorkspacePanelManifest => Boolean(panel));
}

export function registerWorkspacePanel(manifest: WorkspacePanelManifest): boolean {
	if (!manifest || !isValidWorkspacePanelId(manifest.id) || !manifest.label || !manifest.component) {
		return false;
	}
	panelRegistry.update((registry) => ({
		...registry,
		[manifest.id]: {
			...manifest,
			id: manifest.id.trim()
		}
	}));
	return true;
}

export function unregisterWorkspacePanel(panelId: WorkspacePanelId): void {
	if (DEFAULT_WORKSPACE_PANEL_IDS.includes(panelId as (typeof DEFAULT_WORKSPACE_PANEL_IDS)[number])) {
		return;
	}
	panelRegistry.update((registry) => {
		const next = { ...registry };
		delete next[panelId];
		return next;
	});
}

export function canAccessWorkspacePanel(manifest: WorkspacePanelManifest, user: User | null | undefined): boolean {
	if (!manifest.permissions || manifest.permissions.length === 0) return true;
	const role = user?.highestRole || 'member';
	const roleRank = role === 'owner' ? 3 : role === 'admin' ? 2 : role === 'mod' ? 1 : 0;
	return manifest.permissions.every((permission) => {
		const normalized = permission.replace(/^role:/, '').trim().toLowerCase();
		if (normalized === 'owner') return roleRank >= 3;
		if (normalized === 'admin') return roleRank >= 2;
		if (normalized === 'mod' || normalized === 'moderator') return roleRank >= 1;
		return true;
	});
}

export function coercePluginWorkspacePanels(plugin: WorkspacePanelPluginRecord): WorkspacePanelManifest[] {
	const pluginId = String(plugin.id || '').trim();
	if (!pluginId) return [];
	const declarations = [
		...(plugin.frontendExtensions?.workspacePanels || []),
		...(plugin.workspacePanels || [])
	];

	return declarations
		.map((declaration, index): WorkspacePanelManifest | null => {
			const rawId = declaration.id ? `${pluginId}:${declaration.id}` : `${pluginId}:panel`;
			if (!isValidWorkspacePanelId(rawId)) return null;
			const label = String(declaration.label || plugin.name || pluginId).trim();
			if (!label) return null;
			const requestedComponent = String(declaration.component || '').trim() as WorkspacePanelComponentKey;
			const component = KNOWN_COMPONENT_KEYS.has(requestedComponent) ? requestedComponent : 'addon-fallback';
			return {
				id: rawId,
				label,
				shortLabel: declaration.shortLabel,
				icon: declaration.icon || 'box',
				component,
				capabilities: declaration.capabilities || [],
				defaultDock: declaration.defaultDock || declaration.preferredDockArea || 'right',
				preferredDockArea: declaration.preferredDockArea || declaration.defaultDock || 'right',
				mobileMode: declaration.mobileMode || 'sheet',
				badge: declaration.badge ?? null,
				permissions: declaration.permissions || plugin.permissions || [],
				settingsRoute: declaration.settingsRoute,
				pluginId,
				source: 'addon',
				fallbackBehavior: declaration.fallbackBehavior || {
					title: `${label} is not available in this build`,
					message: `The add-on declared a workspace panel, but ${brandName} does not have a trusted frontend component for it yet.`
				},
				sortOrder: declaration.sortOrder ?? 300 + index
			};
		})
		.filter((panel): panel is WorkspacePanelManifest => Boolean(panel));
}

export function registerPluginWorkspacePanels(plugins: WorkspacePanelPluginRecord[]): void {
	for (const plugin of plugins) {
		for (const panel of coercePluginWorkspacePanels(plugin)) {
			registerWorkspacePanel(panel);
		}
	}
}

export function getFallbackWorkspacePanelId(panelIds: WorkspacePanelId[]): WorkspacePanelId {
	const registry = get(panelRegistry);
	return panelIds.find((panelId) => Boolean(registry[panelId])) || FALLBACK_WORKSPACE_PANEL_ID;
}
