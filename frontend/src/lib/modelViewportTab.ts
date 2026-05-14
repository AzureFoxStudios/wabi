import { writable } from 'svelte/store';
import { mobileTabQueue } from '$lib/mobileTabQueue';

export const MODEL_VIEWPORT_ADDON_ID = 'model-viewport';

type ModelViewportSource = 'chat' | 'local-temp';

export interface ModelViewportSelection {
	id: string;
	src: string;
	fileName: string;
	updatedAt: number;
	source: ModelViewportSource;
}

export interface ModelViewportHistoryEntry {
	id: string;
	src: string;
	fileName: string;
	updatedAt: number;
	source: ModelViewportSource;
}

const modelViewportSelection = writable<ModelViewportSelection | null>(null);
const modelViewportHistory = writable<ModelViewportHistoryEntry[]>([]);
const MAX_MODEL_HISTORY = 12;

function makeModelId(): string {
	return `model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function pushHistory(entry: ModelViewportHistoryEntry): void {
	modelViewportHistory.update((entries) => {
		const filtered = entries.filter((item) => item.src !== entry.src);
		return [entry, ...filtered].slice(0, MAX_MODEL_HISTORY);
	});
}

function openModelViewportWithSource(src: string, fileName: string, source: ModelViewportSource): void {
	if (!src) return;
	const entry: ModelViewportHistoryEntry = {
		id: makeModelId(),
		src,
		fileName: fileName || '3D model',
		updatedAt: Date.now(),
		source
	};
	modelViewportSelection.set(entry);
	pushHistory(entry);
	openModelViewportSurface();
}

export function openModelViewport(src: string, fileName: string): void {
	openModelViewportWithSource(src, fileName, 'chat');
}

export function openModelViewportSurface(): void {
	mobileTabQueue.openAddonTab(MODEL_VIEWPORT_ADDON_ID);
}

export function openTemporaryModelViewport(file: File): void {
	const objectUrl = URL.createObjectURL(file);
	openModelViewportWithSource(objectUrl, file.name || 'Local model', 'local-temp');
}

export function openModelViewportHistoryEntry(entryId: string): void {
	if (!entryId) return;
	let next: ModelViewportHistoryEntry | null = null;
	modelViewportHistory.update((entries) => {
		const found = entries.find((entry) => entry.id === entryId) || null;
		if (!found) return entries;
		next = { ...found, updatedAt: Date.now() };
		const remaining = entries.filter((entry) => entry.id !== found.id);
		return next ? [next, ...remaining] : entries;
	});
	if (next) {
		modelViewportSelection.set(next);
		openModelViewportSurface();
	}
}

export function clearModelViewport(): void {
	modelViewportSelection.set(null);
}

export { modelViewportSelection, modelViewportHistory };
