import type { Channel, Message } from '$lib/socket';

export const FALLBACK_ROLE_LABELS: Record<string, string> = {
	owner: 'Owner',
	admin: 'Admin',
	mod: 'Moderator',
	member: 'Member',
	guest: 'Guest'
};

export function formatBadge(count: number): string {
	if (count === 0) return '';
	if (count <= 10) return `+${count}`;
	return '*';
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
 */
export function resolveDropGap(
	anchors: DragAnchor[],
	y: number,
	draggingFolder: boolean,
	containerTop: number,
	scrollTop: number,
	contentEndY: number
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
