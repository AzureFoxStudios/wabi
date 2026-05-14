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

export function getSocket(): Socket | null {
	return socketManager.getSocket();
}

export function initSocket(username: string, authToken?: string): Socket | null {
	return socketManager.connect(username, authToken);
}

export function disconnect(): void {
	socketManager.disconnect();
}

export function getConnectionState() {
	return socketManager.getState();
}
