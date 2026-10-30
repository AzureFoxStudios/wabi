import { derived, get, writable } from 'svelte/store';
import { brandName } from '$lib/branding';
import type { User } from '$lib/socket-types';
import type { IconName } from '$lib/components/ui/icons';
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
	| 'wiki'
	| 'forum'
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
	| 'profile'
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
	| 'calls'
	| 'wiki'
	| 'forum';

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
	/** The panel's one name (§9.6): its rail stub, frame title and Add panels row. */
	label: string;
	/** A shorter rail label, only for add-on names too long to read vertically. */
	shortLabel?: string;
	/** A panel vocabulary name, or any registry glyph (WorkspacePanelIcon.svelte maps both). */
	icon: WorkspacePanelIcon | IconName;
	/** One line under the label in the Add panels popover, and row B of a panel without a toolbar. */
	description?: string;
	/** The panel draws its own masthead row B (search and filter, 40px) as its first child. */
	ownsToolbar?: boolean;
	/** Row A offers "Open in center stage" (§7.21: Notes, Wiki, Forum, DMs). */
	opensInStage?: boolean;
	/** Where the panel's data lives, said once in row A as a locality tag (§8.4, §9.3). */
	locality?: string;
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
	icon?: WorkspacePanelIcon | IconName;
	description?: string;
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
		id: 'model-viewport',
		label: 'Models',
		icon: 'box',
		description: 'Inspect 3D models beside the page',
		component: 'model-viewport',
		capabilities: ['model-workspace'],
		defaultDock: 'right',
		mobileMode: 'fullscreen',
		source: 'core',
		sortOrder: 54
	},
	{
		id: 'calls',
		label: 'Calls',
		// The speaker is the voice-room glyph; headphones mean "Listening" (§6).
		icon: 'voice',
		description: 'Rooms you are in, with a volume for each',
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
		description: 'Who is here, grouped by where they are',
		ownsToolbar: true,
		component: 'users',
		capabilities: ['search', 'profile-actions', 'quick-dm'],
		defaultDock: 'right',
		mobileMode: 'sheet',
		source: 'core',
		sortOrder: 10
	},
	{
		id: 'dms',
		label: 'DMs',
		icon: 'messages',
		description: 'Your direct and group conversations',
		ownsToolbar: true,
		opensInStage: true,
		component: 'dms',
		capabilities: ['compose', 'payments', 'notes-entry'],
		defaultDock: 'right',
		mobileMode: 'fullscreen',
		source: 'core',
		sortOrder: 20
	},
	{
		id: 'profile',
		label: 'Profile',
		icon: 'user',
		description: 'Your profile and how others see it',
		component: 'profile',
		capabilities: ['complete-profile', 'profile-actions'],
		defaultDock: 'right',
		mobileMode: 'fullscreen',
		source: 'core',
		sortOrder: 25
	},
	{
		id: 'notes',
		label: 'Notes',
		icon: 'notes',
		description: 'Personal notes, kept on this device',
		ownsToolbar: true,
		opensInStage: true,
		locality: 'Only you · this device',
		component: 'notes',
		capabilities: ['scratchpad', 'local-persistence'],
		defaultDock: 'bottom',
		mobileMode: 'sheet',
		source: 'core',
		sortOrder: 30
	},
	{
		id: 'whiteboard-layers',
		label: 'Whiteboard layers',
		shortLabel: 'Layers',
		icon: 'layers',
		description: 'Layers of the whiteboard on the page',
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
		description: 'Places shared in this community',
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
		description: 'Albums of shared pictures and video',
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
		description: 'Moderation, roles and server controls',
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
		icon: 'transfers',
		description: 'Files sent straight between devices',
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
		icon: 'code',
		description: 'Browse the project repository',
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
		icon: 'tasks',
		description: 'Your tasks from My Planner',
		component: 'planner-tasks',
		capabilities: ['planner', 'todo-list'],
		defaultDock: 'right',
		mobileMode: 'sheet',
		source: 'core',
		sortOrder: 57
	},
	{
		id: 'wiki',
		label: 'Wiki',
		icon: 'wiki',
		description: 'Read a wiki channel beside the page',
		ownsToolbar: true,
		opensInStage: true,
		component: 'wiki',
		capabilities: ['channel-scoped', 'wiki-channel'],
		defaultDock: 'right',
		mobileMode: 'sheet',
		source: 'core',
		sortOrder: 58
	},
	{
		id: 'forum',
		label: 'Forum',
		icon: 'forum',
		description: 'Read a forum channel beside the page',
		ownsToolbar: true,
		opensInStage: true,
		component: 'forum',
		capabilities: ['channel-scoped', 'forum-channel'],
		defaultDock: 'right',
		mobileMode: 'sheet',
		source: 'core',
		sortOrder: 59
	}
];

const panelRegistry = writable<Record<WorkspacePanelId, WorkspacePanelManifest>>(
	Object.fromEntries(BUILTIN_WORKSPACE_PANELS.map((panel) => [panel.id, panel]))
);
const KNOWN_COMPONENT_KEYS = new Set<WorkspacePanelComponentKey>([
	'users',
	'profile',
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
	'planner-tasks',
	'wiki',
	'forum'
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
				description: typeof declaration.description === 'string' ? declaration.description.trim() || undefined : undefined,
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

/**
 * The count beside a companion's title in its frame (row A, §7.21), set by the panel that knows
 * it (People: the people listed). A panel that never sets one shows no count; null clears it.
 */
const frameCounts = writable<Record<string, number | string>>({});
export const panelFrameCounts = { subscribe: frameCounts.subscribe };

export function setPanelFrameCount(panelId: WorkspacePanelId, count: number | string | null | undefined): void {
	frameCounts.update((counts) => {
		const blank = count === null || count === undefined || count === '';
		if (blank ? !(panelId in counts) : counts[panelId] === count) return counts;
		const next = { ...counts };
		if (blank) delete next[panelId];
		else next[panelId] = count;
		return next;
	});
}

/**
 * The channel a Wiki or Forum companion is reading (null: none chosen yet). Kept here so the
 * frame's "Open in center stage" opens the same channel, and a stowed or re-mounted panel keeps it.
 */
export type ChannelCompanionKind = 'wiki' | 'forum';
const companionChannels = writable<Record<ChannelCompanionKind, string | null>>({ wiki: null, forum: null });
export const panelChannelChoice = { subscribe: companionChannels.subscribe };

/**
 * The person asked for the list ("All wikis" / "All forums"): the picker shows even while the stage
 * reads a channel of that kind, until they choose one. Without this the stage channel would be
 * picked again at once and the list could never be reached.
 */
const companionPicking = writable<Record<ChannelCompanionKind, boolean>>({ wiki: false, forum: false });
export const panelChannelPicking = { subscribe: companionPicking.subscribe };

/** Point the companion at a channel (null forgets the choice). Ends a requested picker. */
export function choosePanelChannel(kind: ChannelCompanionKind, channelId: string | null): void {
	companionChannels.update((choice) => (choice[kind] === channelId ? choice : { ...choice, [kind]: channelId }));
	companionPicking.update((picking) => (picking[kind] ? { ...picking, [kind]: false } : picking));
}

/** "All wikis" / "All forums": forget the choice and show the picker until one is chosen. */
export function showPanelChannelPicker(kind: ChannelCompanionKind): void {
	companionChannels.update((choice) => (choice[kind] === null ? choice : { ...choice, [kind]: null }));
	companionPicking.update((picking) => (picking[kind] ? picking : { ...picking, [kind]: true }));
}

/**
 * Which channel a Wiki/Forum companion shows (§8.4): the one it was pointed at while that channel
 * still exists, else the channel open on the stage when it is of that kind, else the only channel
 * of the kind. With several and none chosen, or while the person asked for the list, it shows the
 * picker (null). A single channel always opens directly: there is no list to choose from.
 */
export function resolvePanelChannel(
	chosen: string | null,
	ofKind: readonly { id: string }[],
	stageChannelId: string | null,
	picking = false
): string | null {
	if (ofKind.length === 1) return ofKind[0].id;
	if (picking) return null;
	if (chosen && ofKind.some((channel) => channel.id === chosen)) return chosen;
	if (stageChannelId && ofKind.some((channel) => channel.id === stageChannelId)) return stageChannelId;
	return null;
}

/**
 * The channel the Wiki/Forum companion of this kind shows right now, from every channel the
 * client knows: the same answer the panel renders, so the frame never acts on a stale choice.
 */
export function panelChannelShown(
	kind: ChannelCompanionKind,
	choice: Readonly<Record<ChannelCompanionKind, string | null>>,
	picking: Readonly<Record<ChannelCompanionKind, boolean>>,
	channels: readonly { id: string; type?: string }[],
	stageChannelId: string | null
): string | null {
	const ofKind = channels.filter((channel) => channel.type === kind);
	return resolvePanelChannel(choice[kind], ofKind, stageChannelId, picking[kind]);
}
