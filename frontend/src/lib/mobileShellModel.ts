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
	| 'workspace'
	| 'conversation'
	| 'browse'
	| 'overlay'
	| 'server-switcher'
	| 'settings';

export type MobileSurfaceState = {
	workspaceOpen: boolean;
	conversationOpen: boolean;
	browseOpen: boolean;
	rightOverlayOpen: boolean;
	serverSwitcherOpen: boolean;
	settingsOpen: boolean;
};

const MOBILE_SURFACE_DISCOVERY_ORDER: MobileBackSurface[] = [
	'workspace',
	'conversation',
	'browse',
	'overlay',
	'server-switcher',
	'settings'
];

function surfaceIsActive(surface: MobileBackSurface, state: MobileSurfaceState): boolean {
	switch (surface) {
		case 'workspace': return state.workspaceOpen;
		case 'conversation': return state.conversationOpen;
		case 'browse': return state.browseOpen;
		case 'overlay': return state.rightOverlayOpen;
		case 'server-switcher': return state.serverSwitcherOpen;
		case 'settings': return state.settingsOpen;
	}
}

export function reconcileMobileSurfaceStack(
	previous: readonly MobileBackSurface[],
	state: MobileSurfaceState
): MobileBackSurface[] {
	const next = previous.filter((surface) => surfaceIsActive(surface, state));
	const present = new Set(next);
	for (const surface of MOBILE_SURFACE_DISCOVERY_ORDER) {
		if (surfaceIsActive(surface, state) && !present.has(surface)) {
			next.push(surface);
			present.add(surface);
		}
	}
	if (next.length === previous.length && next.every((surface, index) => surface === previous[index])) {
		return previous as MobileBackSurface[];
	}
	return next;
}

export function nextMobileBackSurface(stack: readonly MobileBackSurface[]): MobileBackSurface | 'root' {
	return stack.length ? stack[stack.length - 1] : 'root';
}
