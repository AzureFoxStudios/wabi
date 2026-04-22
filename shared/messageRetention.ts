export const MESSAGE_RETENTION_PRESETS = [
	'5s',
	'30s',
	'1m',
	'5m',
	'30m',
	'1h',
	'6h',
	'12h',
	'24h',
	'3d',
	'7d',
	'14d',
	'30d',
	'90d'
] as const;

export type MessageRetentionDuration = (typeof MESSAGE_RETENTION_PRESETS)[number];

export const DEFAULT_DM_RETENTION: MessageRetentionDuration = '24h';

export const MESSAGE_RETENTION_LABELS: Record<MessageRetentionDuration, string> = {
	'5s': '5 seconds',
	'30s': '30 seconds',
	'1m': '1 minute',
	'5m': '5 minutes',
	'30m': '30 minutes',
	'1h': '1 hour',
	'6h': '6 hours',
	'12h': '12 hours',
	'24h': '24 hours',
	'3d': '3 days',
	'7d': '7 days',
	'14d': '14 days',
	'30d': '30 days',
	'90d': '90 days'
};

const MESSAGE_RETENTION_MS: Record<MessageRetentionDuration, number> = {
	'5s': 5 * 1000,
	'30s': 30 * 1000,
	'1m': 60 * 1000,
	'5m': 5 * 60 * 1000,
	'30m': 30 * 60 * 1000,
	'1h': 60 * 60 * 1000,
	'6h': 6 * 60 * 60 * 1000,
	'12h': 12 * 60 * 60 * 1000,
	'24h': 24 * 60 * 60 * 1000,
	'3d': 3 * 24 * 60 * 60 * 1000,
	'7d': 7 * 24 * 60 * 60 * 1000,
	'14d': 14 * 24 * 60 * 60 * 1000,
	'30d': 30 * 24 * 60 * 60 * 1000,
	'90d': 90 * 24 * 60 * 60 * 1000
};

export function isMessageRetentionDuration(value: unknown): value is MessageRetentionDuration {
	return typeof value === 'string' && MESSAGE_RETENTION_PRESETS.includes(value as MessageRetentionDuration);
}

export function normalizeMessageRetentionDuration(value: unknown): MessageRetentionDuration | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim().toLowerCase();
	return isMessageRetentionDuration(normalized) ? normalized : null;
}

export function messageRetentionToMs(duration: MessageRetentionDuration | null | undefined): number | null {
	if (!duration) return null;
	return MESSAGE_RETENTION_MS[duration] ?? null;
}

export function formatMessageRetentionLabel(duration: MessageRetentionDuration | null | undefined): string {
	if (!duration) return 'Never';
	return MESSAGE_RETENTION_LABELS[duration] || 'Custom';
}
