import type { Channel } from '$lib/socket';

export type MobileRootDestination = 'messages' | 'servers' | 'activity' | 'you';

export function isConversationChannel(channel: Pick<Channel, 'type'>): boolean {
	return channel.type === 'dm' || channel.type === 'group';
}

export function sumUnreadConversationCount(
	channelUnreadCounts: Record<string, number> | null | undefined,
	channels: Array<Pick<Channel, 'id' | 'type'>> | null | undefined
): number {
	if (!channelUnreadCounts || !channels?.length) return 0;
	const conversationIds = new Set(
		channels.filter(isConversationChannel).map((channel) => channel.id)
	);
	let total = 0;
	for (const [channelId, rawCount] of Object.entries(channelUnreadCounts)) {
		if (!conversationIds.has(channelId)) continue;
		const count = Number(rawCount);
		if (!Number.isFinite(count) || count <= 0) continue;
		total += Math.floor(count);
	}
	return total;
}

export function formatMobileUnreadBadge(count: number): string {
	if (!Number.isFinite(count) || count <= 0) return '';
	if (count > 99) return '99+';
	return String(Math.floor(count));
}

export function shouldRenderMobileNavigation(options: {
	isMobile: boolean;
	isInCall: boolean;
	keyboardOpen?: boolean;
}): boolean {
	return options.isMobile && !options.isInCall && !options.keyboardOpen;
}

export type MobileBackSurface =
	| 'settings'
	| 'server-switcher'
	| 'browse'
	| 'overlay'
	| 'conversation'
	| 'root';

export function nextMobileBackSurface(state: {
	settingsOpen: boolean;
	serverSwitcherOpen: boolean;
	browseOpen: boolean;
	rightOverlayOpen: boolean;
	conversationOpen: boolean;
}): MobileBackSurface {
	if (state.settingsOpen) return 'settings';
	if (state.serverSwitcherOpen) return 'server-switcher';
	if (state.browseOpen) return 'browse';
	if (state.rightOverlayOpen) return 'overlay';
	if (state.conversationOpen) return 'conversation';
	return 'root';
}
