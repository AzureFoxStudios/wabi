/**
 * The phone and tablet shell model (design contract §8.12, §8.13): which root destination the
 * navigation marks, what each tab says and counts, the Back stack of surfaces opened over the
 * root, and the width the sidebar takes in the compact tablet band. MainLayout, MobileNav and
 * YouPage render this; mobileShellModel.test.ts pins it.
 */
import type { Channel } from '$lib/socket';

// ---------------------------------------------------------------- unread counts

export function isConversationChannel(channel: Pick<Channel, 'type'>): boolean {
	return channel.type === 'dm' || channel.type === 'group';
}

function sumUnread(
	channelUnreadCounts: Record<string, number> | null | undefined,
	channels: Array<Pick<Channel, 'id' | 'type'>> | null | undefined,
	include: (channel: Pick<Channel, 'id' | 'type'>) => boolean
): number {
	if (!channelUnreadCounts || !channels?.length) return 0;
	const ids = new Set(channels.filter(include).map((channel) => channel.id));
	let total = 0;
	for (const [channelId, rawCount] of Object.entries(channelUnreadCounts)) {
		if (!ids.has(channelId)) continue;
		const count = Number(rawCount);
		if (!Number.isFinite(count) || count <= 0) continue;
		total += Math.floor(count);
	}
	return total;
}

/** Unread messages in DMs and groups: the DMs tab's count. */
export function sumUnreadConversationCount(
	channelUnreadCounts: Record<string, number> | null | undefined,
	channels: Array<Pick<Channel, 'id' | 'type'>> | null | undefined
): number {
	return sumUnread(channelUnreadCounts, channels, isConversationChannel);
}

/**
 * Unread messages in the community's own channels (everything the Channels drawer lists): the
 * Channels tab's count. DMs and groups count on DMs instead, and ids the channel list does not
 * know are left out, so the two tabs never count one message twice.
 */
export function sumUnreadCommunityCount(
	channelUnreadCounts: Record<string, number> | null | undefined,
	channels: Array<Pick<Channel, 'id' | 'type'>> | null | undefined
): number {
	return sumUnread(channelUnreadCounts, channels, (channel) => !isConversationChannel(channel));
}

/** Badge numerals (§7.9): 1–99, then "99+"; nothing for zero. */
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

// ---------------------------------------------------------------- root navigation

/** The five root destinations, in nav order (§8.12): Chat · Channels · DMs · Activity · You. */
export type MobileNavDestination = 'chat' | 'channels' | 'dms' | 'activity' | 'you';
export const MOBILE_NAV_ORDER: readonly MobileNavDestination[] = ['chat', 'channels', 'dms', 'activity', 'you'];

/** MainLayout's own place (its `activeView`). */
export type ShellView = 'chat' | 'business' | 'screen' | 'following' | 'dm' | 'server';

export interface MobileNavPlace {
	/** The Channels drawer is open. */
	channelsOpen: boolean;
	/** The You page is in the stage. */
	youOpen: boolean;
	/** Settings is open over the shell. */
	settingsOpen: boolean;
	activeView: ShellView;
	/** The workspace view the stage resolves to ('messages' is the channel chat). */
	workspaceView: string;
	/** A DM conversation is open in center stage. */
	conversationOpen: boolean;
}

/**
 * Which tab says "you are here" (aria-current="page"), or null when the stage shows a place the
 * nav does not name (Server home, reached from the Channels drawer; the following feed).
 * Chat stays active while any channel workspace is in center stage (Calls, My Planner, Files,
 * the office tools…): the stage's "Chat ▾" button names the workspace, so the two never disagree.
 * The order follows what is actually on screen: an open drawer or the You page covers the stage,
 * and Server home owns the stage whatever workspace is selected underneath.
 */
export function mobileNavDestination(place: MobileNavPlace): MobileNavDestination | null {
	if (place.channelsOpen) return 'channels';
	if (place.youOpen || place.settingsOpen) return 'you';
	if (place.activeView === 'server') return null;
	if (place.workspaceView === 'notifications') return 'activity';
	if (place.workspaceView === 'messages') {
		if (place.activeView === 'dm' || place.conversationOpen) return 'dms';
		if (place.activeView === 'following') return null;
	}
	return 'chat';
}

export interface MobileNavCounts {
	/** Unread messages in community channels. */
	channelsUnread: number;
	/** Unread messages in DMs and groups. */
	dmsUnread: number;
	/** Friend requests waiting for an answer (answered in DMs › Friends). */
	friendRequests: number;
	/** Activity that needs you (the folio's Activity count). */
	activity: number;
}

export interface MobileNavLabels {
	chat: string;
	channels: string;
	dms: string;
	activity: string;
	you: string;
	/** "3 unread" */
	unread?: (count: number) => string;
	/** "1 friend request" */
	friendRequests?: (count: number) => string;
	/** "Activity, 2 need you" (the whole name, so a locale can order it). */
	activityNeedsYou?: (count: number) => string;
	/** Appended to You: the presence the avatar's dot shows ("Away"). */
	youDetail?: string;
}

export type MobileNavIcon = 'chat' | 'hash' | 'dm' | 'bell';

export interface MobileNavItem {
	id: MobileNavDestination;
	label: string;
	/** Registry glyph; You shows the person's avatar instead. */
	icon: MobileNavIcon | null;
	/** Badge numerals ('' for none). */
	badge: string;
	/** The tab's accessible name, counts included (the badge itself is aria-hidden). */
	ariaLabel: string;
	current: boolean;
}

const englishUnread = (count: number) => `${count} unread`;
const englishFriendRequests = (count: number) => `${count} friend ${count === 1 ? 'request' : 'requests'}`;
const englishNeedsYou = (count: number) => `Activity, ${count} ${count === 1 ? 'needs' : 'need'} you`;

function positive(count: number): number {
	return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/** The five tabs with their words, badges and accessible names. */
export function mobileNavItems(
	active: MobileNavDestination | null,
	counts: MobileNavCounts,
	labels: MobileNavLabels
): MobileNavItem[] {
	const unread = labels.unread ?? englishUnread;
	const requests = labels.friendRequests ?? englishFriendRequests;
	const needsYou = labels.activityNeedsYou ?? englishNeedsYou;
	const channels = positive(counts.channelsUnread);
	const dms = positive(counts.dmsUnread);
	const friends = positive(counts.friendRequests);
	const activity = positive(counts.activity);
	const name = (label: string, details: string[]) => [label, ...details].join(', ');
	const items: Array<Omit<MobileNavItem, 'current'>> = [
		{ id: 'chat', label: labels.chat, icon: 'chat', badge: '', ariaLabel: labels.chat },
		{
			id: 'channels',
			label: labels.channels,
			icon: 'hash',
			badge: formatMobileUnreadBadge(channels),
			ariaLabel: name(labels.channels, channels ? [unread(channels)] : [])
		},
		{
			// Friend requests are answered in DMs › Friends, so they count on DMs too.
			id: 'dms',
			label: labels.dms,
			icon: 'dm',
			badge: formatMobileUnreadBadge(dms + friends),
			ariaLabel: name(labels.dms, [...(dms ? [unread(dms)] : []), ...(friends ? [requests(friends)] : [])])
		},
		{
			id: 'activity',
			label: labels.activity,
			icon: 'bell',
			badge: formatMobileUnreadBadge(activity),
			ariaLabel: activity ? needsYou(activity) : labels.activity
		},
		{ id: 'you', label: labels.you, icon: null, badge: '', ariaLabel: name(labels.you, labels.youDetail ? [labels.youDetail] : []) }
	];
	return items.map((item) => ({ ...item, current: item.id === active }));
}

// ---------------------------------------------------------------- Back stack

export type MobileBackSurface =
	| 'workspace'
	| 'conversation'
	| 'you'
	| 'browse'
	| 'overlay'
	| 'server-switcher'
	| 'settings';

export type MobileSurfaceState = {
	workspaceOpen: boolean;
	conversationOpen: boolean;
	/** The You page is in the stage. */
	youOpen: boolean;
	browseOpen: boolean;
	rightOverlayOpen: boolean;
	serverSwitcherOpen: boolean;
	settingsOpen: boolean;
};

const MOBILE_SURFACE_DISCOVERY_ORDER: MobileBackSurface[] = [
	'workspace',
	'conversation',
	'you',
	'browse',
	'overlay',
	'server-switcher',
	'settings'
];

function surfaceIsActive(surface: MobileBackSurface, state: MobileSurfaceState): boolean {
	switch (surface) {
		case 'workspace': return state.workspaceOpen;
		case 'conversation': return state.conversationOpen;
		case 'you': return state.youOpen;
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

// ---------------------------------------------------------------- tablet bands

/** The compact sidebar rail (§8.1, §8.13). */
export const COMPACT_RAIL_WIDTH = 60;

/**
 * The width the sidebar column takes in flow. In the 769–1023px band it is the 60px compact rail
 * by default, and the full sidebar opens over the stage as a drawer (so the stage never reflows);
 * the stored width is the person's desktop preference and is never rewritten by the band. A
 * sidebar the person closed (0) stays closed.
 */
export function sidebarFlowWidth(storedWidth: number, compactBand: boolean): number {
	const width = Number.isFinite(storedWidth) ? Math.max(0, storedWidth) : 0;
	if (!compactBand || width === 0) return width;
	return COMPACT_RAIL_WIDTH;
}

// ---------------------------------------------------------------- You page

/** The Settings pages the You page opens directly (null opens the list of every page). */
export type YouSettingsPage = 'profile' | 'notifications' | 'appearance' | 'privacy';
