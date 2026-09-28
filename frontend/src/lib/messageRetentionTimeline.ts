export type RetentionEpoch = {
	fromMicros: number;
	label: string;
	durationMs: number | null;
};

/** The policy in force when a message was sent stays with that message. */
export function messageDeadlineFromTimeline(
	createdAtMs: number,
	epochs: readonly RetentionEpoch[] | null
): number | null {
	if (!epochs || !Number.isFinite(createdAtMs)) return null;
	const createdAtMicros = createdAtMs * 1000;
	for (let index = epochs.length - 1; index >= 0; index--) {
		const epoch = epochs[index];
		if (createdAtMicros < epoch.fromMicros) continue;
		return epoch.durationMs === null ? null : createdAtMs + epoch.durationMs;
	}
	return null;
}

export function parseRetentionTimeline(value: unknown): RetentionEpoch[] | null {
	if (!value || typeof value !== 'object' || !Array.isArray((value as { epochs?: unknown }).epochs)) return null;
	const input = (value as { epochs: unknown[] }).epochs;
	if (input.length === 0) return null;
	const epochs: RetentionEpoch[] = [];
	for (const item of input) {
		if (!item || typeof item !== 'object') return null;
		const epoch = item as Record<string, unknown>;
		if (!Number.isSafeInteger(epoch.fromMicros) || (epoch.fromMicros as number) < 0 ||
			typeof epoch.label !== 'string' ||
			(epoch.durationMs !== null && (!Number.isSafeInteger(epoch.durationMs) || (epoch.durationMs as number) <= 0))) return null;
		if (epochs.length === 0 && epoch.fromMicros !== 0) return null;
		if (epochs.length > 0 && (epoch.fromMicros as number) <= epochs[epochs.length - 1].fromMicros) return null;
		epochs.push({ fromMicros: epoch.fromMicros as number, label: epoch.label, durationMs: epoch.durationMs as number | null });
	}
	return epochs;
}
