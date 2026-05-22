/**
 * callingStdb.ts — StDB (SurrealDB) transport for voice calls.
 *
 * Extracted from calling_impl_core.ts. Owns its private state (stdbCallState,
 * stdbMediaRelay, stdbSessionId, stdbChannelId).
 */

import { get } from 'svelte/store';
import type { Socket } from 'socket.io-client';
import { StdbCallState } from './stdbConnection';
import { StdbMediaRelay } from './stdbMediaRelay';
import {
	connectionState,
	callTransportState,
	localStream
} from './callingStateStores';

// ============================================================================
// Private State
// ============================================================================

let stdbCallState: StdbCallState | null = null;
let stdbMediaRelay: StdbMediaRelay | null = null;
let stdbSessionId: string | null = null;
let stdbChannelId: string | null = null;

// ============================================================================
// StDB Call Functions
// ============================================================================

export async function disconnectStdbCall(): Promise<void> {
	if (stdbMediaRelay) {
		stdbMediaRelay.stop();
		stdbMediaRelay = null;
	}
	if (stdbCallState) {
		if (stdbSessionId) {
			const userId = Math.floor(Math.random() * 1e9);
			stdbCallState.leaveSession(stdbSessionId, userId, '');
		}
		stdbCallState.disconnect();
		stdbCallState = null;
	}
	stdbSessionId = null;
	stdbChannelId = null;
	connectionState.set('idle');
	callTransportState.update((state) => ({
		...state,
		activeTransport: 'p2p' as const,
		reason: 'stdb_disconnected'
	}));
}

export async function connectStdbCall(
	socket: Socket,
	channelId: string,
	localDisplayName: string,
	stdbHost: string = 'ws://localhost:3100',
	stdbDatabase: string = 'wabi-state'
): Promise<void> {
	if (stdbCallState && stdbChannelId === channelId) {
		return;
	}

	await disconnectStdbCall();

	try {
		stdbCallState = new StdbCallState({
			host: stdbHost,
			database: stdbDatabase,
			token: undefined,
		});

		const stream = get(localStream);
		if (!stream) {
			throw new Error('No local audio stream available');
		}

		const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
		stdbSessionId = sessionId;
		stdbChannelId = channelId;

		connectionState.set('connecting');

		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error('STDB connection timeout (10s)'));
			}, 10000);

			stdbCallState!.onConnect(() => {
				clearTimeout(timeout);
				console.log('[STDB] Connected to database');
				resolve();
			});

			stdbCallState!.onError((err) => {
				clearTimeout(timeout);
				console.error('[STDB] Connection error:', err);
				reject(err);
			});

			stdbCallState!.onDisconnect(() => {
				console.log('[STDB] Disconnected from database');
			});

			stdbCallState!.connect();
		});

		const userId = Math.floor(Math.random() * 1e9);
		stdbCallState.createSession(sessionId, channelId, 'audio-call', userId, 100);
		stdbCallState.subscribeToSession(sessionId);

		stdbMediaRelay = new StdbMediaRelay({
			sessionId,
			userId: String(userId),
			socket,
			onError: (err) => console.error('[StdbMediaRelay]', err),
		});

		await stdbMediaRelay.start(stream);
		socket.emit('join-stdb-call', { sessionId, channelId });

		connectionState.set('connected');
		callTransportState.update((state) => ({
			...state,
			activeTransport: 'stdb' as const,
			reason: 'stdb_connected'
		}));

		console.log(`[STDB] Call connected to session ${sessionId}`);
	} catch (error) {
		console.error('[STDB] Connection failed:', error);
		await disconnectStdbCall();
		throw error;
	}
}