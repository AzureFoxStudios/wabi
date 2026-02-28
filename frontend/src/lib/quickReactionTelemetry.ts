import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';

export type QuickReactionTelemetryEvent = 'quick_strip_click' | 'picker_open';

export interface QuickReactionTelemetrySnapshot {
	quickStripClicks: number;
	pickerOpens: number;
	lastUpdatedAt: number | null;
}

// Stored in browser localStorage only. This module never sends counters over the network.
const QUICK_REACTION_TELEMETRY_KEY = 'wabi.quickReactions.telemetry';

const DEFAULT_QUICK_REACTION_TELEMETRY: QuickReactionTelemetrySnapshot = {
	quickStripClicks: 0,
	pickerOpens: 0,
	lastUpdatedAt: null
};

function sanitizeTelemetryValue(value: unknown): number {
	const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
	if (!Number.isFinite(parsed) || parsed < 0) return 0;
	return Math.floor(parsed);
}

function sanitizeQuickReactionTelemetry(
	input: Partial<QuickReactionTelemetrySnapshot> | null | undefined
): QuickReactionTelemetrySnapshot {
	const current = input || {};
	const lastUpdatedAtRaw =
		typeof current.lastUpdatedAt === 'number' && Number.isFinite(current.lastUpdatedAt)
			? Math.floor(current.lastUpdatedAt)
			: null;
	return {
		quickStripClicks: sanitizeTelemetryValue(current.quickStripClicks),
		pickerOpens: sanitizeTelemetryValue(current.pickerOpens),
		lastUpdatedAt: lastUpdatedAtRaw && lastUpdatedAtRaw > 0 ? lastUpdatedAtRaw : null
	};
}

function safeReadQuickReactionTelemetry(): QuickReactionTelemetrySnapshot {
	if (!browser) return { ...DEFAULT_QUICK_REACTION_TELEMETRY };
	try {
		const raw = localStorage.getItem(QUICK_REACTION_TELEMETRY_KEY);
		if (!raw) return { ...DEFAULT_QUICK_REACTION_TELEMETRY };
		const parsed = JSON.parse(raw) as Partial<QuickReactionTelemetrySnapshot>;
		return sanitizeQuickReactionTelemetry(parsed);
	} catch {
		return { ...DEFAULT_QUICK_REACTION_TELEMETRY };
	}
}

function safeWriteQuickReactionTelemetry(value: QuickReactionTelemetrySnapshot): void {
	if (!browser) return;
	try {
		localStorage.setItem(QUICK_REACTION_TELEMETRY_KEY, JSON.stringify(value));
	} catch {
		// best-effort persistence
	}
}

export const quickReactionTelemetryStore = writable<QuickReactionTelemetrySnapshot>(
	safeReadQuickReactionTelemetry()
);

if (browser) {
	quickReactionTelemetryStore.subscribe((snapshot) => {
		safeWriteQuickReactionTelemetry(sanitizeQuickReactionTelemetry(snapshot));
	});
}

export function recordQuickReactionTelemetry(event: QuickReactionTelemetryEvent): void {
	quickReactionTelemetryStore.update((current) => {
		const next: QuickReactionTelemetrySnapshot = {
			quickStripClicks: current.quickStripClicks,
			pickerOpens: current.pickerOpens,
			lastUpdatedAt: Date.now()
		};
		if (event === 'quick_strip_click') {
			next.quickStripClicks += 1;
		} else if (event === 'picker_open') {
			next.pickerOpens += 1;
		}
		return sanitizeQuickReactionTelemetry(next);
	});
}

export function resetQuickReactionTelemetry(): void {
	quickReactionTelemetryStore.set({ ...DEFAULT_QUICK_REACTION_TELEMETRY });
}

export function getQuickReactionTelemetrySnapshot(): QuickReactionTelemetrySnapshot {
	return get(quickReactionTelemetryStore);
}

export function getQuickReactionClickShare(
	snapshot: QuickReactionTelemetrySnapshot = getQuickReactionTelemetrySnapshot()
): number | null {
	const total = snapshot.quickStripClicks + snapshot.pickerOpens;
	if (total <= 0) return null;
	return snapshot.quickStripClicks / total;
}
