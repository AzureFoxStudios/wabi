import type { Readable } from 'svelte/store';

export interface DrawerChannelItem {
	id: string;
	channelId: string;
	serverUrl: string;
	label: string;
	channelType: string | null;
	badgeCount: number;
	active: boolean;
	followedAt: number;
}

export interface FollowedServerGroup {
	serverUrl: string;
	serverName: string;
	serverIconUrl: string | null;
	serverIconLabel: string;
	currentServer: boolean;
	sortOrder: number;
	channels: DrawerChannelItem[];
}

interface ServerChannel {
	id: string;
	name: string;
	type: string | null;
}

interface SavedServer {
	url: string;
	effectiveName: string;
	effectiveIconUrl: string | null;
	order: number;
}

interface FollowPreference {
	channelId: string;
	followedAt: number;
}

interface FollowedChannelEntry {
	serverUrl: string;
	preference: FollowPreference;
}

interface ChannelSnapshot {
	serverUrl: string;
	channelId: string;
	serverName: string;
	channelName: string;
	channelType: string | null;
	unreadCount: number;
}

interface ChannelUnreadCounts {
	[channelId: string]: number;
}

function defaultServerName(serverUrl: string): string {
	try {
		return new URL(serverUrl).hostname;
	} catch {
		return serverUrl;
	}
}

export function buildChannelItem(
	channel: ServerChannel,
	source: 'recent' | 'saved',
	activeFollowServerUrl: string,
	currentChannel: string | null,
	channelUnreadCounts: ChannelUnreadCounts
): DrawerChannelItem {
	return {
		id: `${source}:${channel.id}`,
		channelId: channel.id,
		serverUrl: activeFollowServerUrl,
		label: channel.name,
		channelType: channel.type || 'text',
		badgeCount: channelUnreadCounts[channel.id] || 0,
		active: currentChannel === channel.id,
		followedAt: Date.now()
	};
}

export function buildFollowedServerGroups(
	allServerFollowedChannels: FollowedChannelEntry[],
	savedServers: SavedServer[],
	snapshotByKey: Map<string, ChannelSnapshot>,
	activeFollowServerUrl: string,
	currentSavedServer: { effectiveName?: string; effectiveIconUrl?: string | null } | null,
	channelById: Map<string, ServerChannel>,
	channelUnreadCounts: ChannelUnreadCounts,
	currentChannel: string | null
): FollowedServerGroup[] {
	const savedServerByUrl = new Map(savedServers.map((server) => [server.url, server] as const));
	const grouped = new Map<string, FollowedServerGroup>();

	for (const { serverUrl, preference } of allServerFollowedChannels) {
		const snapshot = snapshotByKey.get(`${serverUrl}::${preference.channelId}`);
		const savedServer = savedServerByUrl.get(serverUrl) || null;
		const currentServer = serverUrl === activeFollowServerUrl;
		const liveChannel = currentServer ? channelById.get(preference.channelId) : null;
		const serverName =
			savedServer?.effectiveName ||
			snapshot?.serverName ||
			(currentServer ? currentSavedServer?.effectiveName : null) ||
			defaultServerName(serverUrl);
		const serverIconUrl =
			savedServer?.effectiveIconUrl ||
			(currentServer ? currentSavedServer?.effectiveIconUrl || null : null);

		if (!grouped.has(serverUrl)) {
			grouped.set(serverUrl, {
				serverUrl,
				serverName,
				serverIconUrl,
				serverIconLabel: serverName.trim().charAt(0).toUpperCase() || 'W',
				currentServer,
				sortOrder: savedServer?.order ?? Number.MAX_SAFE_INTEGER,
				channels: []
			});
		}

		const group = grouped.get(serverUrl)!;
		group.channels.push({
			id: `saved:${serverUrl}:${preference.channelId}`,
			channelId: preference.channelId,
			serverUrl,
			label: liveChannel?.name || snapshot?.channelName || preference.channelId,
			channelType: liveChannel?.type || snapshot?.channelType || 'text',
			badgeCount:
				currentServer
					? channelUnreadCounts[preference.channelId] || 0
					: snapshot?.unreadCount || 0,
			active: currentServer && currentChannel === preference.channelId,
			followedAt: preference.followedAt
		});
	}

	return [...grouped.values()]
		.map((group) => ({
			...group,
			channels: [...group.channels].sort((a, b) => a.followedAt - b.followedAt)
		}))
		.sort((a, b) => {
			if (a.currentServer !== b.currentServer) return a.currentServer ? -1 : 1;
			if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
			return a.serverName.localeCompare(b.serverName);
		});
}

export function followedServerGroupBodyId(serverUrl: string): string {
	return `followed-group-${serverUrl.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')}`;
}
