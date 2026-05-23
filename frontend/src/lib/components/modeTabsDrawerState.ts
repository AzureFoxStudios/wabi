import { get } from 'svelte/store';
import { getSocket, joinChannel, joinVoiceChannel } from '$lib/socket';
import {
	currentSavedServer,
	savedServers,
	switchToSavedServerChannel
} from '$lib/savedServers';
import {
	allServerFollowedChannels,
	getCurrentFollowServerUrl,
	unfollowChannel
} from '$lib/following';
import { followedChannelSnapshots } from '$lib/followingSnapshots';
import { isServerScopedChannel } from '$lib/channelTypes';
import {
	buildChannelItem,
	buildFollowedServerGroups,
	followedServerGroupBodyId,
	type DrawerChannelItem,
	type FollowedServerGroup
} from './modeTabsDrawerHelpers';
import { mobileTabQueue, type MobileQueueTab } from '$lib/mobileTabQueue';

export interface DrawerComputedState {
	serverScopedChannels: Array<{ id: string; type: string }>;
	channelById: Map<string, { id: string; type: string }>;
	serverIconUrl: string | null;
	serverIconLabel: string;
	activeFollowServerUrl: string | null;
	snapshotByKey: Map<string, any>;
	followedServerGroups: FollowedServerGroup[];
	recentChannelItems: DrawerChannelItem[];
	followedCount: number;
	recentCount: number;
	hasVisibleItems: boolean;
	drawerToggleLabel: string;
	activeSectionSubtitle: string;
}

export function computeDrawerState(
	channels: Array<{ id: string; type: string }>,
	currentChannel: string | null,
	channelUnreadCounts: Record<string, number>,
	savedServersList: Array<{ url: string; effectiveIconUrl?: string; effectiveName?: string }>,
	currentSavedServer: { url: string; effectiveIconUrl?: string; effectiveName?: string } | null,
	followedSnapshots: Array<{ serverUrl: string; channelId: string }>
): DrawerComputedState {
	const serverScopedChannels = (channels as any).filter(isServerScopedChannel);
	const channelById = new Map(serverScopedChannels.map((channel) => [channel.id, channel] as const));
	const serverIconUrl = currentSavedServer?.effectiveIconUrl || null;
	const serverIconLabel = (currentSavedServer?.effectiveName || 'Wabi').trim().charAt(0).toUpperCase() || 'W';
	const activeFollowServerUrl = getCurrentFollowServerUrl();
	const snapshotByKey = new Map(
		followedSnapshots.map((snapshot) => [`${snapshot.serverUrl}::${snapshot.channelId}`, snapshot] as const)
	);
	const followedServerGroups = (buildFollowedServerGroups as any)(
		get(allServerFollowedChannels),
		savedServersList as any,
		snapshotByKey as any,
		activeFollowServerUrl,
		currentSavedServer,
		channelById as any,
		channelUnreadCounts,
		currentChannel
	);
	const queueTabs = (mobileTabQueue as any).tabs;
	const recentChannelItems = queueTabs
		.filter((item): item is Extract<MobileQueueTab, { type: 'channel' }> => item.type === 'channel')
		.map((item) => {
			const channel = channelById.get(item.channelId);
			if (!channel) return null;
			return buildChannelItem(channel as any, 'recent', activeFollowServerUrl, currentChannel, channelUnreadCounts);
		})
		.filter((item): item is DrawerChannelItem => item !== null);
	const followedCount = followedServerGroups.reduce((sum, group) => sum + group.channels.length, 0);
	const recentCount = recentChannelItems.length;
	const hasVisibleItems = recentCount > 0 || followedCount > 0;
	const drawerToggleLabel = [
		'Open server shortcuts',
		recentCount > 0 ? `${recentCount} recent channel${recentCount === 1 ? '' : 's'}` : '',
		followedCount > 0 ? `${followedCount} followed channel${followedCount === 1 ? '' : 's'}` : ''
	].filter(Boolean).join(' · ');
	const activeSectionSubtitle = 'recent' === 'recent'
		? 'Recent channels on this server'
		: 'Followed channels across your servers';
	return {
		serverScopedChannels,
		channelById: channelById as any,
		serverIconUrl,
		serverIconLabel,
		activeFollowServerUrl,
		snapshotByKey: snapshotByKey as any,
		followedServerGroups,
		recentChannelItems,
		followedCount,
		recentCount,
		hasVisibleItems,
		drawerToggleLabel,
		activeSectionSubtitle
	};
}

export async function selectChannel(
	item: DrawerChannelItem,
	activeFollowServerUrl: string | null,
	setDrawerOpen: (open: boolean) => void
): Promise<void> {
	if (item.serverUrl !== activeFollowServerUrl) {
		switchToSavedServerChannel(item.serverUrl, item.channelId);
		setDrawerOpen(false);
		return;
	}
	if (item.channelType === 'voice') {
		try {
			await joinVoiceChannel(item.channelId);
		} catch (error) {
			console.error('Failed to join voice channel from server shortcuts:', error);
		}
		setDrawerOpen(false);
		return;
	}
	joinChannel(item.channelId);
	setDrawerOpen(false);
}

export function removeSavedChannel(item: DrawerChannelItem): void {
	unfollowChannel(item.channelId, item.serverUrl);
}

export function handleDrawerKeydown(event: KeyboardEvent, drawerVisible: boolean): boolean {
	if (event.key === 'Escape' && drawerVisible) {
		return true;
	}
	return false;
}
