import { writable } from 'svelte/store';
import type { Emoji } from './socket-types';

export const emojis = writable<Emoji[]>([]);

export async function initEmojis(): Promise<void> {
	try {
		const res = await fetch('/openmoji/emojis.json');
		if (!res.ok) throw new Error(`Failed to load emoji manifest: ${res.status}`);
		const data: Emoji[] = await res.json();
		emojis.set(data);
	} catch (err) {
		console.warn('[emoji] Failed to load OpenMoji emojis:', err);
	}
}
