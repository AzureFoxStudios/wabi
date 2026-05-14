/**
 * socketConnectionCore.ts
 * SocketManager class: Socket connection lifecycle and state management
 */

import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { browser } from '$app/environment';
import { authStore } from './authStore';
import { getServerUrl, normalizeServerUrl } from './serverUrl';
import { getAuthToken, getGuestSessionId } from './authSession';
import { VALID_TRANSITIONS, ConnectionState, socket, connected, connectionState } from './socketConnectionState';
import { SocketHeartbeat } from './socketConnectionHeartbeat';
import { SocketReconnectionManager } from './socketConnectionReconnect';

function classifyError(errorMessage: string): { fatal: boolean; userMessage: string; errorType: string } {
	const lower = (errorMessage || '').toLowerCase();

	if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid token')) {
		return { fatal: true, userMessage: 'Invalid authentication', errorType: 'AUTH_FAILED' };
	}
	if (lower.includes('403') || lower.includes('forbidden')) {
		return { fatal: true, userMessage: 'Access denied', errorType: 'FORBIDDEN' };
	}
	if (lower.includes('404')) {
		return { fatal: true, userMessage: 'Server not found', errorType: 'NOT_FOUND' };
	}
	if (lower.includes('timeout')) {
		return { fatal: false, userMessage: 'Connection timeout', errorType: 'TIMEOUT' };
	}

	return { fatal: false, userMessage: 'Connection failed', errorType: 'NETWORK_ERROR' };
}

export class SocketManager {
	private socketInstance: Socket | null = null;
	private username: string = '';
	private authToken: string | null = null;
	private currentServerUrl: string | null = null;
	private shouldSyncAfterReconnect = false;

	private state: ConnectionState = 'disconnected';
	private heartbeat: SocketHeartbeat;
	private reconnect: SocketReconnectionManager;
	private connectTimeoutMs = 20000;
	private boundListeners: Set<string> = new Set();

	constructor() {
		this.heartbeat = new SocketHeartbeat(() => this.socketInstance?.disconnect());
		this.reconnect = new SocketReconnectionManager();
	}

	// ==================== STATE MACHINE ====================

	private canTransition(to: ConnectionState): boolean {
		const valid = VALID_TRANSITIONS[this.state];
		return valid.includes(to);
	}

	private transition(to: ConnectionState): boolean {
		if (to === this.state) {
			return true;
		}
		if (!this.canTransition(to)) {
			console.warn(`[SocketManager] Invalid transition: ${this.state} -> ${to}`);
			return false;
		}
		console.log(`[SocketManager] State: ${this.state} -> ${to}`);
		this.state = to;
		connectionState.set(to);
		connected.set(to === 'connected');
		return true;
	}

	// ==================== PUBLIC API ====================

	getSocket(): Socket | null {
		return this.socketInstance;
	}

	getState(): ConnectionState {
		return this.state;
	}

	// ==================== CONFIGURATION ====================

	private isLocalServerUrl(serverUrl: string): boolean {
		try {
			const parsed = new URL(serverUrl);
			const host = parsed.hostname.toLowerCase();
			return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === 'tauri.localhost';
		} catch {
			return false;
		}
	}

	private applyConnectionProfile(serverUrl: string): void {
		if (this.isLocalServerUrl(serverUrl)) {
			this.reconnect.setConfig({ baseDelay: 250, maxDelay: 5000, jitterMs: 120 });
			this.connectTimeoutMs = 8000;
			return;
		}

		this.reconnect.setConfig({ baseDelay: 1000, maxDelay: 30000, jitterMs: 1000 });
		this.connectTimeoutMs = 20000;
	}

	private getAuthCredentials(authToken?: string): { token: string | null; sessionId: string | null } {
		const token = authToken || getAuthToken() || null;
		if (token) return { token, sessionId: null };

		const sessionId = getGuestSessionId() || null;
		return { token: null, sessionId };
	}

	// ==================== RECONNECTION ====================

	private scheduleReconnect(): void {
		if (!this.canTransition('reconnecting')) return;
		if (!this.transition('reconnecting')) return;

		if (this.reconnect.hasExhaustedAttempts()) {
			console.error('[SocketManager] Max reconnect attempts reached');
			this.transition('failed');
			authStore.setAuthError('Connection lost after multiple attempts', 'CONNECTION_FAILED');
			return;
		}

		this.reconnect.incrementAttempt();
		const delay = this.reconnect.calculateBackoffDelay();

		console.log(`[SocketManager] Scheduling reconnect (attempt ${this.reconnect.getAttemptCount()}/${this.reconnect.getMaxAttempts()}) in ${Math.round(delay)}ms`);

		this.reconnect.setReconnectTimer(
			setTimeout(() => {
				this.reconnect.setReconnectTimer(null);
				const currentUrl = normalizeServerUrl(this.currentServerUrl || getServerUrl());
				if (!currentUrl) {
					this.transition('failed');
					return;
				}

				const { rotated, nextUrl } = this.reconnect.rotateToNextFailoverCandidate(this.currentServerUrl);
				if (rotated && nextUrl) {
					this.currentServerUrl = nextUrl;
					this.reconnect.primeFailoverCandidates(nextUrl);
				}

				this.connect(this.username, this.authToken || undefined);
			}, delay)
		);
	}

	private destroySocket(): void {
		if (!this.socketInstance) return;
		try {
			this.socketInstance.removeAllListeners();
			this.socketInstance.disconnect();
		} catch (error) {
			console.warn('[SocketManager] Error destroying socket:', error);
		}
		this.socketInstance = null;
		this.boundListeners.clear();
		socket.set(null);
	}

	// ==================== CONNECTION ====================

	connect(username: string, authToken?: string): Socket | null {
		if (!browser) return null;
		const isReconnectAttempt = this.state === 'reconnecting' || this.reconnect.getAttemptCount() > 0;

		if (this.state === 'connecting') {
			console.log('[SocketManager] Connection in progress, returning existing socket');
			return this.socketInstance;
		}

		if (this.state === 'connected' && this.socketInstance && this.username === username) {
			console.log('[SocketManager] Already connected with same username');
			return this.socketInstance;
		}

		if (!this.canTransition('connecting')) {
			console.warn(`[SocketManager] Cannot connect from state: ${this.state}`);
			this.forceReset();
		}

		this.transition('connecting');
		this.username = username;
		this.authToken = authToken || null;
		if (isReconnectAttempt) {
			this.shouldSyncAfterReconnect = true;
		}

		this.destroySocket();

		let serverUrl = getServerUrl();
		this.currentServerUrl = normalizeServerUrl(serverUrl) || serverUrl;
		this.reconnect.primeFailoverCandidates(serverUrl);
		this.applyConnectionProfile(serverUrl);
		if (this.currentServerUrl) {
			void this.reconnect.refreshFailoverCandidates(this.currentServerUrl);
		}

		const { token, sessionId } = this.getAuthCredentials(authToken);

		console.log('[SocketManager] Connecting to:', serverUrl, token ? '(token)' : sessionId ? '(session)' : '(new)');

		this.socketInstance = io(serverUrl, {
			transports: ['websocket', 'polling'],
			reconnection: false,
			timeout: this.connectTimeoutMs,
			withCredentials: true,
			auth: {
				token: token || undefined,
				sessionId: !token ? sessionId || undefined : undefined
			},
			forceNew: true
		});

		this.bindEventListeners();
		socket.set(this.socketInstance);

		return this.socketInstance;
	}

	disconnect(): void {
		console.log('[SocketManager] Disconnect requested');
		this.reconnect.cancelReconnect();
		this.heartbeat.stop();
		this.destroySocket();
		this.username = '';
		this.authToken = null;
		this.reconnect.resetAttempts();
		this.currentServerUrl = null;
		this.shouldSyncAfterReconnect = false;
		this.transition('disconnected');
	}

	private forceReset(): void {
		console.warn('[SocketManager] Force resetting from state:', this.state);
		this.reconnect.cancelReconnect();
		this.heartbeat.stop();
		this.destroySocket();
		this.state = 'disconnected';
		this.reconnect.resetAttempts();
		connectionState.set('disconnected');
		connected.set(false);
	}

	// ==================== EVENT LISTENERS ====================

	private bindEventListeners(): void {
		if (!this.socketInstance) return;

		const sock = this.socketInstance;

		sock.removeAllListeners();
		this.boundListeners.clear();

		sock.on('connect', () => {
			console.log('[SocketManager] Connected, socket.id:', sock.id);

			this.transition('connected');
			this.reconnect.resetAttempts();
			this.currentServerUrl = normalizeServerUrl(getServerUrl()) || this.currentServerUrl;
			if (this.currentServerUrl) {
				this.reconnect.primeFailoverCandidates(this.currentServerUrl);
				void this.reconnect.refreshFailoverCandidates(this.currentServerUrl);
			}
			this.heartbeat.start(sock);

			const { sessionId } = this.getAuthCredentials();
			if (sessionId && !this.authToken) {
				console.log('[SocketManager] Rejoin with sessionId');
				sock.emit('rejoin', sessionId);
			} else {
				console.log('[SocketManager] Join as:', this.username);
				sock.emit('join', this.username);
			}
		});

		sock.on('connect_error', (error) => {
			const msg = error?.message || String(error);
			console.error('[SocketManager] Connect error:', msg);

			const errorInfo = classifyError(msg);

			if (errorInfo.fatal) {
				this.transition('failed');
				authStore.setAuthError(errorInfo.userMessage, errorInfo.errorType as any);
				return;
			}

			if (this.canTransition('reconnecting')) {
				this.scheduleReconnect();
			}
		});

		sock.on('disconnect', (reason, details) => {
			console.log('[SocketManager] Disconnected:', reason, details);

			this.heartbeat.stop();

			switch (reason) {
				case 'io server disconnect':
				case 'io client disconnect':
					this.transition('disconnected');
					break;

				case 'ping timeout':
				case 'transport close':
				case 'transport error':
					if (this.canTransition('reconnecting')) {
						this.scheduleReconnect();
					}
					break;

				default:
					console.warn('[SocketManager] Unknown disconnect reason:', reason);
					if (this.canTransition('reconnecting')) {
						this.scheduleReconnect();
					}
			}
		});

		if (sock.io?.engine) {
			sock.io.engine.on('upgrade', (transport) => {
				console.log('[SocketManager] Transport upgraded to:', transport.name);
			});

			sock.io.engine.on('packet', () => {
				this.heartbeat.recordPong();
			});
		}
	}
}
