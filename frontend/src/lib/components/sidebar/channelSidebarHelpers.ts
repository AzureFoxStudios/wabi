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
