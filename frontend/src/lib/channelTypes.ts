import type { Channel } from './socket-types';

export type RoutedChannelType = 'forum' | 'gallery' | 'wiki' | 'stage' | 'lore' | 'planning';
export type ChannelType = NonNullable<Channel['type']> | RoutedChannelType;

const ROUTED_CHANNEL_TYPES = new Set<string>(['forum', 'gallery', 'wiki', 'stage', 'lore', 'planning']);

export function isRoutedChannelType(type: string | null | undefined): type is RoutedChannelType {
	return Boolean(type && ROUTED_CHANNEL_TYPES.has(type));
}

export function getChannelTypeLabel(type: string | null | undefined): string {
	switch (type) {
		case 'dm':
			return 'DM';
		case 'group':
			return 'Group';
		case 'voice':
			return 'Voice';
		case 'public':
			return 'Public';
		case 'thread_public':
		case 'thread_private':
			return 'Thread';
		case 'forum':
			return 'Forum';
		case 'gallery':
			return 'Gallery';
		case 'wiki':
			return 'Wiki';
		case 'stage':
			return 'Stage';
		case 'lore':
			return 'Asset Storage';
		case 'planning':
			return 'Planning';
		default:
			return 'Text';
	}
}

export function getChannelTypeIcon(type: string | null | undefined): string {
	switch (type) {
		case 'dm':
			return 'DM';
		case 'group':
			return 'GR';
		case 'voice':
			return 'VC';
		case 'forum':
			return 'FO';
		case 'gallery':
			return 'GA';
		case 'wiki':
			return 'WI';
		case 'stage':
			return 'ST';
		case 'lore':
			return 'LO';
		case 'planning':
			return 'PL';
		case 'thread_public':
		case 'thread_private':
			return 'TH';
		default:
			return '#';
	}
}

export function isServerScopedChannel(channel: Channel): boolean {
	return channel.type !== 'dm';
}

export function isTextLikeChannelType(type: string | null | undefined): boolean {
	return !isRoutedChannelType(type) && type !== 'voice' && type !== 'stage';
}
