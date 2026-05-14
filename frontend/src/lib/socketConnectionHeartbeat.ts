/**
 * socketConnectionHeartbeat.ts
 * Heartbeat/keepalive monitoring for Socket.IO connection
 */

import type { Socket } from 'socket.io-client';

export class SocketHeartbeat {
	private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
	private lastPong: number = 0;
	private readonly heartbeatIntervalMs = 25000;
	private readonly heartbeatTimeoutMs = 35000;
	private onHeartbeatTimeout: (() => void) | null = null;

	constructor(onTimeout?: () => void) {
		this.onHeartbeatTimeout = onTimeout || null;
	}

	start(socket: Socket): void {
		if (this.heartbeatInterval) return;

		this.heartbeatInterval = setInterval(() => {
			if (!socket?.connected) {
				this.stop();
				return;
			}

			const elapsed = Date.now() - this.lastPong;
			if (elapsed > this.heartbeatTimeoutMs) {
				console.warn('[SocketHeartbeat] Heartbeat timeout — forcing reconnect');
				this.stop();
				this.onHeartbeatTimeout?.();
			}
		}, this.heartbeatIntervalMs);
	}

	stop(): void {
		if (this.heartbeatInterval) {
			clearInterval(this.heartbeatInterval);
			this.heartbeatInterval = null;
		}
	}

	recordPong(): void {
		this.lastPong = Date.now();
	}
}
