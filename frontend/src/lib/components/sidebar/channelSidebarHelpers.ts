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
