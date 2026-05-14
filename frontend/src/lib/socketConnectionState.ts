/**
 * socketConnectionState.ts
 * State machine, stores, and type definitions for Socket.IO connection
 */

import { writable } from 'svelte/store';

export type ConnectionState =
	| 'disconnected'
	| 'connecting'
	| 'connected'
	| 'reconnecting'
	| 'failed';

export const VALID_TRANSITIONS: Record<ConnectionState, ConnectionState[]> = {
	disconnected: ['connecting'],
	connecting: ['connected', 'reconnecting', 'failed', 'disconnected'],
	connected: ['reconnecting', 'disconnected'],
	reconnecting: ['connecting', 'failed', 'disconnected'],
	failed: ['disconnected', 'connecting']
};

export interface RoleDefinition {
	roleName: string;
	displayName: string;
	priority: number;
	color: string | null;
	isHoisted: boolean;
}

export const socket = writable<any>(null);
export const connected = writable(false);
export const connectionState = writable<ConnectionState>('disconnected');
