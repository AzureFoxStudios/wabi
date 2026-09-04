/**
 * WabiDbCallState — wabidb-backed call-session client.
 *
 * Uses native WebSocket + HTTP against the wabi-server endpoints.
 *
 * API surface is intentionally close to the previous call-state shape so
 * wabidbMediaRelay.ts can be re-wired with minimal changes.
 */

import type {
  StateCallSessionRow,
  StateCallParticipantRow,
  StateCallSignalRow,
} from './wabidbCallTypes';
import { getAuthToken } from './authSession';
import { tryRefresh } from './api/authRefresh';

export interface WabiDbCallConfig {
  serverUrl: string; // e.g. "https://wabi.example.com" (no trailing slash)
  token?: string; // bearer token from Wabi auth
}

export interface CallSubscriptionHandle {
  unsubscribe: () => void;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export class WabiDbCallState {
  private cfg: WabiDbCallConfig;
  private ws: WebSocket | null = null;
  private _isConnected = false;
  private subscribedSessionIds: Set<string> = new Set();
  private handles: CallSubscriptionHandle[] = [];
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private explicitlyClosed = false;

  // Last-seen row caches (per session id) for state restoration after reconnect.
  private sessionCache: Map<string, StateCallSessionRow> = new Map();
  private participantCache: Map<string, StateCallParticipantRow[]> = new Map();
  private signalListeners: ((row: StateCallSignalRow) => void)[] = [];

  private _onConnect?: () => void;
  private _onDisconnect?: () => void;
  private _onError?: (err: Error) => void;
  private _onSessionChange?: (rows: StateCallSessionRow[]) => void;
  private _onParticipantChange?: (rows: StateCallParticipantRow[]) => void;
  private _onSignal?: (row: StateCallSignalRow) => void;

  constructor(cfg: WabiDbCallConfig) {
    this.cfg = cfg;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  connect(): void {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return;
    this.explicitlyClosed = false;
    this.openWebSocket();
  }

  disconnect(): void {
    this.explicitlyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._isConnected = false;
  }

  // --- HTTP writes ---
  //
  // All call HTTP goes through authedFetch: on a 401 (the 15-minute access
  // token expired mid-call) it silent-refreshes once and retries. Without
  // this a single expiry killed every relay (re)connect with
  // `createSession failed: 401` while the socket itself stayed up, so
  // presence looked alive and media just died.

  private async authedFetch(url: string, init: RequestInit): Promise<Response> {
    const withLiveAuth = (): RequestInit => {
      const headers = new Headers(init.headers);
      const live = getAuthToken();
      const token = live || this.cfg.token;
      if (token) headers.set('authorization', `Bearer ${token}`);
      return { ...init, headers };
    };
    let res = await fetch(url, withLiveAuth());
    if (res.status === 401) {
      let refreshed = false;
      try {
        refreshed = await tryRefresh();
      } catch {
        refreshed = false;
      }
      if (refreshed) {
        res = await fetch(url, withLiveAuth());
      }
    }
    return res;
  }

  async createSession(
    sessionId: string,
    channelId: string,
    callType: string,
    hostUserId: number,
    maxParticipants = 0,
  ): Promise<void> {
    const res = await this.authedFetch(`${this.cfg.serverUrl}/api/calls/sessions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        session_id: sessionId,
        channel_id: channelId,
        call_type: callType,
        max_participants: maxParticipants,
        transport: 'wabidb',
      }),
    });
    if (!res.ok) throw new Error(`createSession failed: ${res.status}`);
  }

  async joinSession(
    sessionId: string,
    _userId: number,
    stableUserId: string,
  ): Promise<void> {
    const res = await this.authedFetch(`${this.cfg.serverUrl}/api/calls/sessions/${encodeURIComponent(sessionId)}/join`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ stable_user_id: stableUserId }),
    });
    if (!res.ok) throw new Error(`joinSession failed: ${res.status}`);
  }

  async leaveSession(
    sessionId: string,
    _userId: number,
    _stableUserId: string,
  ): Promise<void> {
    const res = await this.authedFetch(`${this.cfg.serverUrl}/api/calls/sessions/${encodeURIComponent(sessionId)}/leave`, {
      method: 'POST',
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`leaveSession failed: ${res.status}`);
  }

  async endSession(
    sessionId: string,
    _userId?: number,
    _stableUserId?: string,
  ): Promise<void> {
    const res = await this.authedFetch(`${this.cfg.serverUrl}/api/calls/sessions/${encodeURIComponent(sessionId)}/end`, {
      method: 'POST',
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`endSession failed: ${res.status}`);
  }

  async emitSignal(
    sessionId: string,
    _userId: number,
    signalType: string,
    payloadJson: string,
    targetUserId?: number,
  ): Promise<void> {
    const res = await this.authedFetch(`${this.cfg.serverUrl}/api/calls/sessions/${encodeURIComponent(sessionId)}/signals`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        signal_type: signalType,
        target_user_id: targetUserId ?? null,
        payload: payloadJson,
      }),
    });
    if (!res.ok) throw new Error(`emitSignal failed: ${res.status}`);
  }

  // --- HTTP reads (fallback when WS push is unavailable) ---

  async getSession(sessionId: string): Promise<StateCallSessionRow | undefined> {
    const res = await this.authedFetch(`${this.cfg.serverUrl}/api/calls/sessions/${encodeURIComponent(sessionId)}`, {
      headers: this.headers(),
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`getSession failed: ${res.status}`);
    const data = (await res.json()) as { session: any };
    return wabidbSessionToRow(data.session);
  }

  async getParticipants(sessionId: string): Promise<StateCallParticipantRow[]> {
    const res = await this.authedFetch(`${this.cfg.serverUrl}/api/calls/sessions/${encodeURIComponent(sessionId)}/participants`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`getParticipants failed: ${res.status}`);
    const data = (await res.json()) as { participants: any[] };
    return data.participants.map(wabidbParticipantToRow);
  }

  async getSignals(
    sessionId: string,
    since: number = 0,
  ): Promise<StateCallSignalRow[]> {
    const url = `${this.cfg.serverUrl}/api/calls/sessions/${encodeURIComponent(sessionId)}/signals?since=${since}`;
    const res = await this.authedFetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`getSignals failed: ${res.status}`);
    const data = (await res.json()) as { signals: any[] };
    return data.signals.map(wabidbSignalToRow);
  }

  // --- Subscriptions (no-op stubs for v1: WS push not wired yet) ---
  // Clients should call getSession/getParticipants/getSignals on demand
  // (HTTP polling). The interface matches the prior call-state shape.

  subscribeToSession(sessionId: string): CallSubscriptionHandle[] {
    // Track the subscription locally for clean teardown.
    this.subscribedSessionIds.add(sessionId);

    // Send the subscribe_call message over WS if connected. If not connected,
    // openWebSocket() will re-send it on reconnect.
    this.sendWsMessage({ type: 'subscribe_call', session_id: sessionId });

    const handle: CallSubscriptionHandle = {
      unsubscribe: () => {
        this.subscribedSessionIds.delete(sessionId);
        this.sendWsMessage({ type: 'unsubscribe_call', session_id: sessionId });
      },
    };
    this.handles.push(handle);
    return [handle];
  }

  unsubscribeAll(): void {
    for (const h of this.handles) {
      try { h.unsubscribe(); } catch (_) { /* ignore */ }
    }
    this.handles = [];
  }

  // --- Event handlers ---

  onConnect(cb: () => void): void { this._onConnect = cb; }
  onDisconnect(cb: () => void): void { this._onDisconnect = cb; }
  onError(cb: (err: Error) => void): void { this._onError = cb; }

  // One-shot waiters for the WS handshake. The legacy single-slot onConnect
  // callback above loses resolvers when two handshakes overlap (the second
  // overwrites the first's resolve and the first hangs until timeout, then
  // its catch tears down the healthy relay). Waiters stack: every pending
  // requestConnect settles on open/error/close.
  private connectWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  private settleConnectWaiters(resolve: boolean, err?: Error): void {
    if (this.connectWaiters.length === 0) return;
    const waiters = this.connectWaiters;
    this.connectWaiters = [];
    for (const w of waiters) {
      try {
        if (resolve) w.resolve();
        else w.reject(err ?? new Error('WebSocket closed during handshake'));
      } catch { /* waiter already settled via timeout */ }
    }
  }

  /**
   * Resolve when the WS is open (immediately if already connected).
   * Rejects on WS error/close or after timeoutMs. Safe under overlap: every
   * caller gets its own waiter instead of fighting over one callback slot.
   */
  requestConnect(timeoutMs = 10000): Promise<void> {
    if (this._isConnected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.connectWaiters.indexOf(waiter);
        if (idx !== -1) this.connectWaiters.splice(idx, 1);
        reject(new Error(`Wabidb connection timeout (${Math.round(timeoutMs / 1000)}s)`));
      }, timeoutMs);
      const waiter = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (err: Error) => { clearTimeout(timer); reject(err); },
      };
      this.connectWaiters.push(waiter);
      this.connect();
    });
  }
  onSessionChange(cb: (rows: StateCallSessionRow[]) => void): void { this._onSessionChange = cb; }
  onParticipantChange(cb: (rows: StateCallParticipantRow[]) => void): void { this._onParticipantChange = cb; }
  onSignal(cb: (row: StateCallSignalRow) => void): void {
    this._onSignal = cb;
    this.signalListeners.push(cb);
  }

  // --- Internal ---

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    // Prefer the LIVE auth token on every request. The cfg.token captured at
    // construction goes stale after the 15-minute access-token rotation and
    // every session call then 401s until a page reload.
    const live = getAuthToken();
    const token = live || this.cfg.token;
    if (token) h['authorization'] = `Bearer ${token}`;
    return h;
  }

  private openWebSocket(): void {
    try {
      const wsUrl = this.cfg.serverUrl.replace(/^http/, 'ws') + '/ws';
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this._isConnected = true;
        this.reconnectAttempts = 0;
        this._onConnect?.();
        this.settleConnectWaiters(true);
        // Re-subscribe to any active sessions
        for (const sessionId of this.subscribedSessionIds) {
          this.sendWsMessage({ type: 'subscribe_call', session_id: sessionId });
        }
      };

      this.ws.onclose = () => {
        this._isConnected = false;
        this._onDisconnect?.();
        this.settleConnectWaiters(false, new Error('WebSocket closed during handshake'));
        if (!this.explicitlyClosed) this.scheduleReconnect();
      };

      this.ws.onerror = (e) => {
        const err = new Error(`WebSocket error: ${e}`);
        this._onError?.(err);
        this.settleConnectWaiters(false, err);
      };

      this.ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          this.handleWsMessage(msg);
        } catch (e) {
          this._onError?.(new Error(`Bad WS message: ${e}`));
        }
      };
    } catch (e) {
      this._onError?.(e as Error);
      this.scheduleReconnect();
    }
  }

  private sendWsMessage(msg: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleWsMessage(msg: any): void {
    switch (msg.type) {
      case 'call_session_changed':
        if (msg.session) {
          const row = wabidbSessionToRow(msg.session);
          this.sessionCache.set(row.sessionId, row);
          this._onSessionChange?.([...this.sessionCache.values()]);
        }
        break;
      case 'call_participant_changed':
        if (msg.participants) {
          const rows = msg.participants.map(wabidbParticipantToRow);
          this.participantCache.set(msg.session_id, rows);
          const all: StateCallParticipantRow[] = [];
          for (const v of this.participantCache.values()) all.push(...v);
          this._onParticipantChange?.(all);
        }
        break;
      case 'call_signal_emitted':
        if (msg.signal) {
          const row = wabidbSignalToRow(msg.signal);
          for (const cb of this.signalListeners) cb(row);
        }
        break;
    }
  }

  private scheduleReconnect(): void {
    if (this.explicitlyClosed) return;
    this.reconnectAttempts++;
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts - 1),
      RECONNECT_MAX_MS,
    );
    this.reconnectTimer = setTimeout(() => this.openWebSocket(), delay);
  }
}

// --- JSON -> row converters ---

function wabidbSessionToRow(s: any): StateCallSessionRow {
  return {
    sessionId: s.session_id,
    channelId: s.channel_id,
    callType: s.call_type,
    hostUserId: s.host_user_id != null ? BigInt(s.host_user_id) : null,
    startedAt: BigInt(s.started_at_micros),
    endedAt: s.ended_at_micros != null ? BigInt(s.ended_at_micros) : null,
    transport: s.transport,
    maxParticipants: BigInt(s.max_participants),
    active: s.active,
    lastUpdatedAt: s.last_updated_at_micros,
  };
}

function wabidbParticipantToRow(p: any): StateCallParticipantRow {
  return {
    participantKey: p.participant_key,
    sessionId: p.session_id,
    userId: BigInt(p.user_id),
    stableUserId: p.stable_user_id,
    joinedAt: BigInt(p.joined_at_micros),
    leftAt: p.left_at_micros != null ? BigInt(p.left_at_micros) : null,
    isHost: p.is_host,
    muted: p.muted,
    videoEnabled: p.video_enabled,
    lastUpdatedAt: p.last_updated_at_micros,
  };
}

function wabidbSignalToRow(s: any): StateCallSignalRow {
  return {
    signalId: Number(s.signal_id),
    sessionId: s.session_id,
    fromUserId: BigInt(s.from_user_id),
    signalType: s.signal_type,
    targetUserId: s.target_user_id != null ? BigInt(s.target_user_id) : null,
    payload: s.payload,
    createdAt: s.created_at_micros,
  };
}