import { getChannelTypeLabel } from './channelTypes';

const DIRECTORY_CHANNEL_TYPES = ['public', 'text', 'voice', 'forum', 'gallery', 'wiki', 'stage', 'lore', 'planning', 'reception'] as const;
const directoryKinds = new Set<string>(DIRECTORY_CHANNEL_TYPES);
type DirectoryChannelType = typeof DIRECTORY_CHANNEL_TYPES[number];
type ChannelSource = { id: string; name: string; type?: string };
export type AdminChannelEntry = ChannelSource & { type: DirectoryChannelType; typeLabel: string };

/** Ordinary server channels only: never expose private conversations or folders. */
export function adminChannelDirectory(channels: readonly ChannelSource[]): AdminChannelEntry[] {
	return channels.flatMap((channel) => {
		if (!channel.type || !directoryKinds.has(channel.type)) return [];
		const type = channel.type as DirectoryChannelType;
		return [{ id: channel.id, name: channel.name, type, typeLabel: getChannelTypeLabel(type) }];
	});
}

export type AdminChannelNavigationIntent = { view: 'chat'; preserveRightPanel: true };

/** Compose the existing owners; viewing a channel must never join/leave media. */
export function createAdminChannelOpener(deps: {
	channels: () => readonly ChannelSource[];
	canOpen: () => boolean;
	selectChannel: (id: string) => void;
	showChannelSurface: () => void;
	closeCenterConversation: () => void;
	leaveAdmin: () => void;
	navigate: (intent: AdminChannelNavigationIntent) => void;
}): (channelId: string) => boolean {
	return (channelId) => {
		if (!deps.canOpen() || !adminChannelDirectory(deps.channels()).some(channel => channel.id === channelId)) return false;
		deps.selectChannel(channelId);
		deps.showChannelSurface();
		deps.closeCenterConversation();
		deps.leaveAdmin();
		// The channel owner already joined its socket room. This intent only
		// resets the shell's local DM/Following view, without closing the dock.
		deps.navigate({ view: 'chat', preserveRightPanel: true });
		return true;
	};
}
