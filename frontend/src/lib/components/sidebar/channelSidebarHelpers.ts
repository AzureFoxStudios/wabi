import type { Channel, Message } from '$lib/socket';

export const FALLBACK_ROLE_LABELS: Record<string, string> = {
	owner: 'Owner',
	admin: 'Admin',
	mod: 'Moderator',
	member: 'Member',
	guest: 'Guest'
};

/**
 * Unread badge numerals (spec §7.9): the plain count from 1 to 99, then "99+". Anything that is
 * not a positive count (0, negative, NaN, Infinity) renders no badge at all.
 */
export function formatBadge(count: number): string {
	if (!Number.isFinite(count) || count < 1) return '';
	const whole = Math.floor(count);
	return whole > 99 ? '99+' : String(whole);
}

/** The words a screen reader hears for a badge ("3 unread"); '' when there is no badge. */
export function unreadLabel(count: number): string {
	const badge = formatBadge(count);
	return badge ? `${badge} unread` : '';
}

/**
 * Accessible name of the DMs row (spec §8.1): "DMs and friends", then what is waiting.
 * "DMs and friends, 2 unread" · "DMs and friends, 1 friend request" · both, comma-separated.
 */
export function dmRowLabel(unread: number, friendRequests: number): string {
	const parts = ['DMs and friends'];
	const unreadWords = unreadLabel(unread);
	if (unreadWords) parts.push(unreadWords);
	const requests = Number.isFinite(friendRequests) ? Math.max(0, Math.floor(friendRequests)) : 0;
	if (requests > 0) parts.push(`${requests} friend request${requests === 1 ? '' : 's'}`);
	return parts.join(', ');
}

/**
 * Widths at or below this render the compact rail (spec §8.1: 60px tiles). The drag handle can
 * leave the column anywhere between "collapsed" (0) and full width, so compact is a range, not
 * the single magic value 60: a 90px or 150px column shows tiles, never half-clipped names or a
 * foot whose buttons run past the edge. (MainLayout should snap this range to 60; see handoffs.)
 */
export const COMPACT_SIDEBAR_MAX_WIDTH = 160;

/**
 * Below this (and above compact) the column is "narrow": the masthead drops its Ctrl K keycap so
 * "Search or jump to" keeps its room. The foot fits its own controls (planSidebarFoot), because
 * what fits there also depends on the pointer and on whether you are in a call.
 */
export const NARROW_SIDEBAR_MAX_WIDTH = 239;

export function isCompactSidebarWidth(width: number): boolean {
	return Number.isFinite(width) && width > 0 && width <= COMPACT_SIDEBAR_MAX_WIDTH;
}

/** How much the column has room for: the 60px rail, a narrow column, or the full layout. */
export type SidebarWidthTier = 'compact' | 'narrow' | 'full';

/**
 * The phone drawer always has the full layout: its width is the drawer's, not the stored desktop
 * column width (which can be anything the drag handle left behind).
 */
export function sidebarWidthTier(width: number, isMobile: boolean): SidebarWidthTier {
	if (isMobile) return 'full';
	if (isCompactSidebarWidth(width)) return 'compact';
	if (Number.isFinite(width) && width > 0 && width <= NARROW_SIDEBAR_MAX_WIDTH) return 'narrow';
	return 'full';
}

/** Kinds whose unread counts belong to DMs and friends, not to the community's channels. */
const PERSONAL_CHANNEL_TYPES = new Set(['dm', 'group']);

/**
 * The community channels (CHANNELS / VOICE, folders, threads) that have unread messages: what
 * "Mark all read" in the CHANNELS menu clears. DMs, group DMs and ids the channel list does not
 * know are left alone, so the DMs badge keeps its own state.
 */
export function communityUnreadIds(
	counts: Record<string, number>,
	channels: Array<Pick<Channel, 'id' | 'type'>>
): string[] {
	const known = new Map(channels.map((channel) => [channel.id, (channel.type as string | undefined) ?? 'text']));
	const ids: string[] = [];
	for (const [id, raw] of Object.entries(counts)) {
		const count = Number(raw);
		if (!Number.isFinite(count) || count <= 0) continue;
		const type = known.get(id);
		if (type === undefined || PERSONAL_CHANNEL_TYPES.has(type)) continue;
		ids.push(id);
	}
	return ids;
}

/**
 * A control in the sidebar foot (spec §8.1 item 8), listed in the order it keeps its place:
 * Mute first, End call while you are in a call, then Deafen and Settings.
 */
export type FootControl = 'mute' | 'end' | 'deafen' | 'settings';

/** The foot's geometry in surfaces/sidebar.css (.sb-foot): padding 16 | 10, avatar 36, gaps. */
export const FOOT_LAYOUT = { padStart: 16, padEnd: 10, avatar: 36, gap: 10, keyGap: 2, minName: 56 } as const;

export interface SidebarFootPlan {
	/** The name over handle block. */
	name: boolean;
	/** Icon buttons shown in the foot, left to right. */
	inline: FootControl[];
	/** Controls with no room: they move into the avatar menu, so nothing is clipped. */
	overflow: FootControl[];
}

/**
 * What the foot shows at a given column width. The name stays while it keeps a readable width,
 * so Settings and then Deafen move into the avatar menu first; then the name goes; then End call
 * and Mute. Keys are 32px, or 44px under a coarse pointer (spec §4.3, §10).
 */
export function planSidebarFoot(width: number, opts: { inCall: boolean; coarse: boolean }): SidebarFootPlan {
	const wanted: FootControl[] = opts.inCall ? ['mute', 'end', 'deafen', 'settings'] : ['mute', 'deafen', 'settings'];
	const { padStart, padEnd, avatar, gap, keyGap, minName } = FOOT_LAYOUT;
	const key = opts.coarse ? 44 : 32;
	const room = Number.isFinite(width) && width > 0 ? width : 0;
	const frame = padStart + avatar + padEnd;
	const keysWidth = (count: number): number => (count === 0 ? 0 : gap + count * key + (count - 1) * keyGap);
	const plan = (name: boolean, count: number): SidebarFootPlan => ({
		name,
		inline: wanted.slice(0, count),
		overflow: wanted.slice(count)
	});
	const essential = opts.inCall ? 2 : 1;
	for (let count = wanted.length; count >= essential; count--) {
		if (room - frame - gap - keysWidth(count) >= minName) return plan(true, count);
	}
	for (let count = wanted.length; count > 0; count--) {
		if (frame + keysWidth(count) <= room) return plan(false, count);
	}
	return plan(false, 0);
}

/** The word for what a sidebar entry is, used in its menu and its delete confirm. */
export type ChannelNoun = 'channel' | 'voice room' | 'group' | 'folder';

export function channelNoun(type: string | null | undefined): ChannelNoun {
	if (type === 'category') return 'folder';
	if (type === 'voice') return 'voice room';
	if (type === 'group') return 'group';
	return 'channel';
}

/**
 * The delete confirm (spec §7.13): a question naming the kind, one consequence sentence, and a
 * verb + object button. A folder with channels offers to keep them at the top level.
 */
export function deleteConfirmCopy(
	noun: ChannelNoun,
	name: string,
	childCount: number
): { title: string; message: string; confirm: string; secondary: string | null } {
	if (noun === 'folder') {
		const children = Number.isFinite(childCount) ? Math.max(0, Math.floor(childCount)) : 0;
		if (children > 0) {
			return {
				title: 'Delete this folder?',
				message: `“${name}” holds ${children} channel${children === 1 ? '' : 's'}. You can keep them at the top level or delete them with the folder.`,
				confirm: 'Delete folder and channels',
				secondary: 'Delete folder, keep channels'
			};
		}
		return { title: 'Delete this folder?', message: `“${name}” is removed for everyone. This can’t be undone.`, confirm: 'Delete folder', secondary: null };
	}
	const subject = noun === 'channel' ? `#${name}` : `“${name}”`;
	return {
		title: `Delete this ${noun}?`,
		message: `${subject} and its messages are removed for everyone. This can’t be undone.`,
		confirm: `Delete ${noun}`,
		secondary: null
	};
}

/** Center-stage views that belong to the selected channel (folio group "This channel", §7.10). */
const CHANNEL_WORKSPACE_VIEWS = new Set(['messages', 'whiteboard', 'files']);

/**
 * Which sidebar entry is "where you are" (spec §5.2, §7.11; exactly one aria-current):
 *  - 'server':  Server home is open → the community block is current;
 *  - 'dm':      the DMs hub is open → the DMs row is current;
 *  - 'channel': the channel's own view (Chat, Files, Whiteboard) is in center stage → its row is
 *               the current page (raise fill, sig glyph);
 *  - 'context': another workspace owns center stage (My Planner, Notes, Calls, Documents…) →
 *               the channel you came from keeps only its sig glyph and is not the page.
 */
export type SidebarPlace = 'server' | 'dm' | 'channel' | 'context';

export function resolveSidebarPlace(activeView: string, workspaceView: string | null | undefined): SidebarPlace {
	if (activeView === 'server') return 'server';
	if (activeView === 'dm') return 'dm';
	if (activeView === 'chat' && CHANNEL_WORKSPACE_VIEWS.has(workspaceView || 'messages')) return 'channel';
	return 'context';
}

/** Voice rooms list at most this many people before "and N more" (spec §7.11). */
export const VOICE_PARTICIPANT_LIMIT = 5;

/**
 * `hidden` drives "and N more"; `collapsible` is true once a long room has been opened, so the
 * same toggle can fold it back to the first `limit` people ("Show less").
 */
export function splitVoiceParticipants<T>(
	people: T[],
	expanded: boolean,
	limit = VOICE_PARTICIPANT_LIMIT
): { shown: T[]; hidden: number; collapsible: boolean } {
	if (people.length <= limit) return { shown: people, hidden: 0, collapsible: false };
	if (expanded) return { shown: people, hidden: 0, collapsible: true };
	return { shown: people.slice(0, limit), hidden: people.length - limit, collapsible: false };
}

/** The 14px state glyph after a voice participant's name and the word it stands for. */
export type VoiceMemberState = { icon: 'mic' | 'micOff' | 'headphones' | 'headphonesOff'; label: string };

export function voiceMemberState(member: {
	speaking?: boolean;
	isMuted?: boolean;
	isDeafened?: boolean;
	isListenOnly?: boolean;
}): VoiceMemberState {
	if (member.isDeafened) return { icon: 'headphonesOff', label: 'Deafened' };
	if (member.isListenOnly) return { icon: 'headphones', label: 'Listening' };
	if (member.isMuted) return { icon: 'micOff', label: 'Muted' };
	if (member.speaking) return { icon: 'mic', label: 'Speaking' };
	return { icon: 'mic', label: 'Mic on' };
}

/**
 * Split the mixed root into the CHANNELS and VOICE sections (spec §8.1). Voice rooms at the top
 * level read under VOICE; a voice room inside a folder stays in its folder, because folders may
 * hold any mix of kinds. Order inside each section is the root order, so reordering still means
 * the same thing.
 */
export function splitRootSections(items: MixedRootItem[]): { channels: MixedRootItem[]; voice: MixedRootItem[] } {
	const channels: MixedRootItem[] = [];
	const voice: MixedRootItem[] = [];
	for (const item of items) {
		if (item.kind === 'channel' && (item.channel.type as string | undefined) === 'voice') voice.push(item);
		else channels.push(item);
	}
	return { channels, voice };
}

export function summarizeGlimpseMessage(message: Message): string {
	if (message.text?.trim()) return message.text.trim();
	if (message.type === 'gif') return 'Shared a GIF';
	if (message.type === 'emoji') return `Reacted with ${message.emojiName || 'an emoji'}`;
	if (message.type === 'file') {
		if (message.files?.length) return `Shared ${message.files.length} files`;
		return `Shared ${message.fileName || 'a file'}`;
	}
	return 'Sent a message';
}

export function formatGlimpseTime(timestamp: number): string {
	try {
		return new Intl.DateTimeFormat(undefined, {
			hour: 'numeric',
			minute: '2-digit'
		}).format(new Date(timestamp));
	} catch {
		return '';
	}
}

export function formatDiag(value: number | null, unit = ''): string {
	if (value == null || Number.isNaN(value)) return '--';
	return `${value}${unit}`;
}

export function formatVoiceDuration(startMs: number | null, nowMs: number): string {
	if (!startMs) return '0:00';
	const elapsedSeconds = Math.max(0, Math.floor((nowMs - startMs) / 1000));
	const hours = Math.floor(elapsedSeconds / 3600);
	const minutes = Math.floor((elapsedSeconds % 3600) / 60);
	const seconds = elapsedSeconds % 60;
	if (hours > 0) {
		return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
	}
	return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function getEffectiveVoiceLimit(channel: Channel): number | null {
	if (channel.type !== 'voice') return null;
	if (channel.voiceSettings?.forceSolo) return 1;
	const configured = channel.voiceSettings?.userLimit;
	if (configured == null) return null;
	if (!Number.isFinite(configured) || configured < 1) return null;
	return configured;
}

export function formatVoiceOccupancy(channel: Channel, memberCount: number): string {
	const limit = getEffectiveVoiceLimit(channel);
	if (limit === null) return String(memberCount);
	return `${memberCount}/${limit}`;
}

export function getVoiceOccupancyTitle(channel: Channel, memberCount: number): string {
	const limit = getEffectiveVoiceLimit(channel);
	if (limit === null) return `${memberCount} in voice`;
	return `${memberCount}/${limit} in voice`;
}

export function sortChannelsByPosition(channels: Channel[]): Channel[] {
	return [...channels].sort(
		(a, b) => (a.position ?? 999) - (b.position ?? 999) || a.name.localeCompare(b.name)
	);
}

export type MixedRootItem =
	| { kind: 'folder'; id: string; channel: Channel; children: Channel[] }
	| { kind: 'channel'; id: string; channel: Channel; isReceptionPinned?: boolean };

/** One root list: folders and uncategorized channels share the same position space. */
export function buildMixedRoot(all: Channel[], sidebarChannels: Channel[]): MixedRootItem[] {
	const folders = sortChannelsByPosition(
		all.filter((channel) => (channel.type as string | undefined) === 'category')
	);
	const folderIds = new Set(folders.map((folder) => folder.id));
	const childrenByFolder = new Map<string, Channel[]>();
	const uncategorized: Channel[] = [];

	for (const channel of sidebarChannels) {
		if ((channel.type as string | undefined) === 'category') continue;
		if (channel.parentId && folderIds.has(channel.parentId)) {
			const children = childrenByFolder.get(channel.parentId) ?? [];
			children.push(channel);
			childrenByFolder.set(channel.parentId, children);
		} else {
			uncategorized.push(channel);
		}
	}

	const reception = all.find((channel) => (channel.type as string | undefined) === 'reception');
	const mixed: MixedRootItem[] = [
		...(reception
			? [
					{
						kind: 'channel' as const,
						id: reception.id,
						channel: reception,
						isReceptionPinned: true
					} satisfies MixedRootItem
				]
			: []),
		...folders.map((folder) => ({
			kind: 'folder' as const,
			id: folder.id,
			channel: folder,
			children: sortChannelsByPosition(childrenByFolder.get(folder.id) ?? [])
		})),
		...sortChannelsByPosition(uncategorized).map((channel) => ({
			kind: 'channel' as const,
			id: channel.id,
			channel
		}))
	];

	return mixed.sort(
		(a, b) =>
			(a.channel.position ?? 999) - (b.channel.position ?? 999) ||
			a.channel.name.localeCompare(b.channel.name)
	);
}

export function filterMixedRoot(items: MixedRootItem[], query: string): MixedRootItem[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return items;
	return items
		.map((item) => {
			if (item.kind === 'channel') {
				return item.channel.name.toLowerCase().includes(needle) ? item : null;
			}
			const children = item.children.filter((channel) =>
				channel.name.toLowerCase().includes(needle)
			);
			if (item.channel.name.toLowerCase().includes(needle) || children.length > 0) {
				return { ...item, children };
			}
			return null;
		})
		.filter((item): item is MixedRootItem => item !== null);
}

// ============================================================================
// DRAG TARGETING — pure geometry shared by the sidebar DnD coordinator.
// Unit-tested in channelSidebarHelpers.test.ts; keep free of DOM/store access.
// ============================================================================

/** One droppable row snapshot captured by the coordinator during a drag. */
export interface DragAnchor {
	kind: 'folder' | 'channel';
	id: string;
	/** Category id when this channel row lives inside an expanded folder. */
	parentFolderId: string | null;
	top: number;
	bottom: number;
}

/**
 * Where a release would land. Anchors resolve to indices at commit time
 * against the full channel model (never the search-filtered view).
 *  - root:         gap in the mixed root sequence (folders + loose channels)
 *  - folder:       gap among a folder's children (positional insert inside)
 *  - folder-header: immediately before/after a folder in the root sequence
 */
export type DropGap =
	| { scope: 'root'; anchorId: string | null; pos: 'before' | 'after' }
	| { scope: 'folder'; categoryId: string; anchorId: string | null; pos: 'before' | 'after' }
	| { scope: 'folder-header'; categoryId: string; pos: 'before' | 'after' };

/** Targeting result: the gap plus where to draw the insertion line. */
export interface ResolvedGap {
	gap: DropGap | null;
	/** Insertion-line Y in scroll-content coordinates (null hides the line). */
	lineY: number | null;
	/** True when the line sits at folder-child depth (deeper indent). */
	indented: boolean;
}

/** Folder-header edge band (px): above/below counts as before/after the folder. */
export const FOLDER_EDGE_BAND_PX = 10;

/**
 * Resolve which gap the pointer occupies.
 *
 * `anchors` MUST be in document order. Dead zones (voice rosters, threads,
 * padding) resolve to the nearest surrounding row, so the line never lies:
 * the last thing it pointed at remains true wherever the cursor wanders.
 * Past the final anchor resolves to the end of the root sequence.
 *
 * @param y            pointer viewport Y
 * @param containerTop viewport Y of the scroll container's top edge
 * @param scrollTop    current scrollTop of the scroll container
 * @param contentEndY  viewport Y of the container's last-content edge (tail line)
 * @param intoFoldersOnly a folder header only means "into this folder" (a voice-room drag: a
 *                     top-level voice room renders under VOICE, so a line at the folder's edge
 *                     in CHANNELS would point where the room never lands)
 */
export function resolveDropGap(
	anchors: DragAnchor[],
	y: number,
	draggingFolder: boolean,
	containerTop: number,
	scrollTop: number,
	contentEndY: number,
	intoFoldersOnly = false
): ResolvedGap {
	const toContentY = (viewportY: number): number => viewportY - containerTop + scrollTop;

	let hit: DragAnchor | null = null;
	for (const anchor of anchors) {
		if (anchor.bottom > y) {
			hit = anchor;
			break;
		}
	}

	if (!hit) {
		return {
			gap: { scope: 'root', anchorId: null, pos: 'after' },
			lineY: toContentY(contentEndY),
			indented: false
		};
	}

	if (hit.kind === 'folder' && intoFoldersOnly && !draggingFolder) {
		return {
			gap: { scope: 'folder', categoryId: hit.id, anchorId: null, pos: 'before' },
			lineY: toContentY(hit.bottom),
			indented: true
		};
	}

	if (hit.kind === 'folder') {
		const band = Math.min(FOLDER_EDGE_BAND_PX, (hit.bottom - hit.top) / 3);
		const mid = (hit.top + hit.bottom) / 2;
		if (y < hit.top + band) {
			return {
				gap: { scope: 'folder-header', categoryId: hit.id, pos: 'before' },
				lineY: toContentY(hit.top),
				indented: false
			};
		}
		if (y > hit.bottom - band) {
			return {
				gap: { scope: 'folder-header', categoryId: hit.id, pos: 'after' },
				lineY: toContentY(hit.bottom),
				indented: false
			};
		}
		if (draggingFolder) {
			// Folders never nest: the middle band degrades to the nearest gap.
			return {
				gap: {
					scope: 'folder-header',
					categoryId: hit.id,
					pos: y < mid ? 'before' : 'after'
				},
				lineY: toContentY(y < mid ? hit.top : hit.bottom),
				indented: false
			};
		}
		// Channel onto folder header ⇒ become the folder's first child.
		return {
			gap: { scope: 'folder', categoryId: hit.id, anchorId: null, pos: 'before' },
			lineY: toContentY(hit.bottom),
			indented: true
		};
	}

	const pos: 'before' | 'after' = y < (hit.top + hit.bottom) / 2 ? 'before' : 'after';
	const lineY = toContentY(pos === 'before' ? hit.top : hit.bottom);
	if (hit.parentFolderId) {
		return {
			gap: { scope: 'folder', categoryId: hit.parentFolderId, anchorId: hit.id, pos },
			lineY,
			indented: true
		};
	}
	return { gap: { scope: 'root', anchorId: hit.id, pos }, lineY, indented: false };
}

/**
 * Participant count for the call diagnostics panel (CallDebugPanel).
 * `activeCalls` is only populated by the WebRTC ontrack handler or an SFU
 * join — neither the wabidb relay nor a demoted-but-idle p2p tail ever
 * touches it — so whenever the voice-channel roster is known it is the
 * truthful count (2026-09-03: a 2-person call read "Participants: 1" on
 * both the relay and the dead p2p tail). Falls back to the legacy
 * 1 + activeCalls formula when no roster applies (DM calls).
 */
export function callParticipantCount(
	activeTransport: string,
	activeCallsLength: number,
	rosterLength: number | null
): number {
	void activeTransport;
	if (rosterLength != null && rosterLength > 0) {
		return rosterLength;
	}
	return 1 + activeCallsLength;
}
