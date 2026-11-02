import { writable } from 'svelte/store';

// Preset swatches are role tokens, never raw colours: the note's dot follows every theme.
// Stored on the note and resolved through a CSS custom property at render time (a 7px dot).
export const NOTE_COLORS: string[] = [
	'var(--w-accent)',
	'var(--w-ok)',
	'var(--w-warn)',
	'var(--w-danger)',
	'var(--w-info)',
	'var(--w-mute)'
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
