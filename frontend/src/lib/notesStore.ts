import { writable } from 'svelte/store';

// Preset swatches mapped to theme tokens (NOT hardcoded brand colors).
// Stored on the note and resolved via a CSS custom property at render time.
export const NOTE_COLORS: string[] = [
	'var(--accent-primary-color)',
	'var(--color-success, #22c55e)',
	'var(--color-warning, #f59e0b)',
	'var(--color-danger, #ef4444)',
	'var(--accent-purple, #9b59b6)',
	'var(--text-secondary, #8a8aa3)'
];

/** N1: floating QuickScratchpad open state (global hotkey + /scratch). */
export const quickScratchpadOpen = writable(false);

export function openQuickScratchpad(): void {
	quickScratchpadOpen.set(true);
}

export function closeQuickScratchpad(): void {
	quickScratchpadOpen.set(false);
}

export function toggleQuickScratchpad(): void {
	quickScratchpadOpen.update((v) => !v);
}
