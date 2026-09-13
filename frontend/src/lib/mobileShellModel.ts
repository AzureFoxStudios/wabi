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

export type MobileSurface =
	| 'settings'
	| 'server-switcher'
	| 'browse'
	| 'overlay'
	| 'conversation'
	| 'workspace';

export type MobileBackSurface = MobileSurface | 'root';
export type MobileSurfaceStack = readonly MobileSurface[];

/**
 * Move a surface to the top of the phone Back stack.
 *
 * A surface is unique in the stack. Re-opening it makes it the most-recent
 * surface instead of creating duplicate Back entries.
 */
export function pushMobileSurface(
	stack: MobileSurfaceStack,
	surface: MobileSurface
): MobileSurface[] {
	return [...stack.filter((entry) => entry !== surface), surface];
}

/** Remove a surface no matter where it sits in the current stack. */
export function removeMobileSurface(
	stack: MobileSurfaceStack,
	surface: MobileSurface
): MobileSurface[] {
	return stack.filter((entry) => entry !== surface);
}

/**
 * Synchronize a visible surface with the ordered stack without disturbing the
 * relative order of unrelated surfaces.
 */
export function syncMobileSurface(
	stack: MobileSurfaceStack,
	surface: MobileSurface,
	visible: boolean
): MobileSurface[] {
	const present = stack.includes(surface);
	if (visible) return present ? [...stack] : [...stack, surface];
	return present ? removeMobileSurface(stack, surface) : [...stack];
}

export function topMobileBackSurface(stack: MobileSurfaceStack): MobileBackSurface {
	return stack.length > 0 ? stack[stack.length - 1] : 'root';
}

/**
 * Compatibility helper for older call sites. New mobile shell code should keep
 * an explicit ordered stack and use topMobileBackSurface instead of deriving
 * Back order from a bag of booleans.
 */
export function nextMobileBackSurface(state: {
	settingsOpen: boolean;
	serverSwitcherOpen: boolean;
	browseOpen: boolean;
	rightOverlayOpen: boolean;
	conversationOpen: boolean;
}): MobileBackSurface {
	let stack: MobileSurface[] = [];
	stack = syncMobileSurface(stack, 'conversation', state.conversationOpen);
	stack = syncMobileSurface(stack, 'overlay', state.rightOverlayOpen);
	stack = syncMobileSurface(stack, 'browse', state.browseOpen);
	stack = syncMobileSurface(stack, 'server-switcher', state.serverSwitcherOpen);
	stack = syncMobileSurface(stack, 'settings', state.settingsOpen);
	return topMobileBackSurface(stack);
}
