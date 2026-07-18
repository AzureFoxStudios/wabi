import { writable } from 'svelte/store';
import type { ObjectRefRecord } from './objectRefRegistry';

export const shareModalRecord = writable<ObjectRefRecord | null>(null);

export function openShareModal(record: ObjectRefRecord): void {
	shareModalRecord.set(record);
}

export function closeShareModal(): void {
	shareModalRecord.set(null);
}
