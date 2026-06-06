/**
 * socketConnection.ts (unified re-export)
 * Maintains 100% backward compatibility
 *
 * Re-exports from:
 * - socketConnectionState.ts: State machine, stores, and types
 * - socketConnectionCore.ts: SocketManager class and connection lifecycle
 * - socketConnectionHeartbeat.ts: Heartbeat monitoring
 * - socketConnectionReconnect.ts: Reconnection logic with failover
 */

import type { Socket } from 'socket.io-client';
import { SocketManager } from './socketConnectionCore';
import { createLocalMockSocket, disconnectLocalMockSocket, isLocalMockMode, type LocalMockSocket } from './localMockSocket';

// ============================================================================
// RE-EXPORTS FROM socketConnectionState.ts
// ============================================================================

export type { ConnectionState } from './socketConnectionState';
export { VALID_TRANSITIONS, type RoleDefinition, socket, connected, connectionState } from './socketConnectionState';

// ============================================================================
// RE-EXPORTS FROM socketConnectionCore.ts
// ============================================================================

export type { SocketManager } from './socketConnectionCore';

// ============================================================================
// SINGLETON INSTANCE AND PUBLIC API
// ============================================================================

export const socketManager = new SocketManager();
let localMockSocket: LocalMockSocket | null = null;

export function getSocket(): Socket | null {
	if (isLocalMockMode()) return localMockSocket as unknown as Socket | null;
	return socketManager.getSocket();
}

export function initSocket(username: string, authToken?: string): Socket | null {
	if (isLocalMockMode()) {
		localMockSocket = createLocalMockSocket(username);
		return localMockSocket as unknown as Socket;
	}
	return socketManager.connect(username, authToken);
}

export function disconnect(): void {
	if (isLocalMockMode()) {
		disconnectLocalMockSocket(localMockSocket);
		localMockSocket = null;
		return;
	}
	socketManager.disconnect();
}

export function getConnectionState() {
	if (isLocalMockMode()) return localMockSocket ? 'connected' : 'disconnected';
	return socketManager.getState();
}
