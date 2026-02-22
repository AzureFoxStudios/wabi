import { writable } from 'svelte/store';

export interface ModelViewportSelection {
	src: string;
	fileName: string;
	updatedAt: number;
}

const modelViewportSelection = writable<ModelViewportSelection | null>(null);

export function openModelViewport(src: string, fileName: string): void {
	if (!src) return;
	modelViewportSelection.set({
		src,
		fileName: fileName || '3D model',
		updatedAt: Date.now()
	});
}

export function clearModelViewport(): void {
	modelViewportSelection.set(null);
}

export { modelViewportSelection };
