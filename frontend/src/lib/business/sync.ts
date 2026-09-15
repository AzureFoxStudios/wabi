import { writable } from 'svelte/store';

export const businessSyncAvailable = writable<boolean>(false);

export async function probeBusinessSyncCapability(): Promise<boolean> {
	return false;
}

export function getBusinessSyncMode(): 'manual' | 'auto' {
	return 'manual';
}

export function setBusinessSyncMode(mode: 'manual' | 'auto'): void {
	// No-op: server business sync does not exist; mode cannot be enabled.
}

export function hasPendingRemoteBusinessUpdate(): boolean {
	return false;
}

export async function pullFromServer(): Promise<boolean> {
	return false;
}

export async function pushToServer(): Promise<boolean> {
	return false;
}

export async function sync(pullFirst = false): Promise<boolean> {
	return false;
}

export function triggerSync(): void {
	// No-op: no server protocol exists for business sync.
}

export function initSync(): void {
	// No-op: no server protocol exists for business sync.
}

export function cleanupSync(): void {
	// No-op: no server protocol exists for business sync.
}
