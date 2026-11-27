import type { ConnectionState } from '$lib/socketConnectionState';

export type BadgeStatus = 'online' | 'offline' | 'connecting' | 'reconnecting' | 'unreachable' | 'idle';

/**
 * What the connection badge says.
 *
 * A connected socket is proof the server is reachable, so it outranks the
 * browser's own offline flag: `navigator.onLine` is wrong on some desktops
 * (VPN-only links, WebKitGTK without a network monitor), and "Work offline"
 * is a choice made before a connection existed. Without this the badge read
 * "Offline" while messages were going out.
 */
export function badgeStatus(socketState: ConnectionState, browserOnline: boolean, workOffline: boolean): BadgeStatus {
	if (socketState === 'connected') return 'online';
	if (!browserOnline || workOffline) return 'offline';
	switch (socketState) {
		case 'connecting':
			return 'connecting';
		case 'reconnecting':
			return 'reconnecting';
		case 'failed':
			return 'unreachable';
		default:
			// Idle or pre-auth (login screen): no socket by design.
			return 'idle';
	}
}
