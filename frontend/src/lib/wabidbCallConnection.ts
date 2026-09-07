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
import { membershipRevision } from './groupMembership';

export interface WabiDbCallConfig {
  serverUrl: string; // e.g. "https://wabi.example.com" (no trailing slash)
}

/** Runtime auth is injected so this transport cannot silently select a different
 * server/account or fall back to a captured token after logout. */
export interface CallStateDependencies {
  getToken: () => string | null;
  refresh: () => Promise<boolean>;
  fetch?: typeof fetch;
  socket?: (url: string) => WebSocket;
}

export interface CallSubscriptionHandle {
  unsubscribe: () => void;
}

export interface CallWriteFence { signal?: AbortSignal; membershipRevision?: string; }
function fencedUrl(url: string, fence?: CallWriteFence): string {
  if (fence?.membershipRevision === undefined) return url;
  if (membershipRevision(fence.membershipRevision) === null) throw new Error('Invalid membership revision');
  return `${url}?membership_revision=${fence.membershipRevision}`;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export class WabiDbCallState {
  private cfg: WabiDbCallConfig;
  private ws: WebSocket | null = null;
  private _isConnected = false;
  private subscriptions = new Map<string, { count: number; revision?: string }>();
  private sentToken: string | null = null;
  private signalCursors = new Map<string, number>();
  private account: string | null = null;
  private renewalTimer: ReturnType<typeof setTimeout> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshPending: Promise<boolean> | null = null;
  private authRetried = false;
  private generation = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private explicitlyClosed = false;

  // Last-seen row caches (per session id) for state restoration after reconnect.
  private sessionCache: Map<string, StateCallSessionRow> = new Map();
  private participantCache: Map<string, StateCallParticipantRow[]> = new Map();

  private _onConnect?: () => void;
  private _onDisconnect?: () => void;
  private _onError?: (err: Error) => void;
  private _onSessionChange?: (rows: StateCallSessionRow[]) => void;
  private _onParticipantChange?: (rows: StateCallParticipantRow[]) => void;
  private _onSignal?: (row: StateCallSignalRow) => void;

  constructor(cfg: WabiDbCallConfig, private deps: CallStateDependencies) {
    const url = new URL(cfg.serverUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid call server URL');
    this.cfg = { serverUrl: cfg.serverUrl.replace(/\/+$/, '') };
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  connect(): void {
    if (this.ws || this.reconnectTimer || this.refreshPending) return;
    this.explicitlyClosed = false;
    this.openWebSocket();
  }

  disconnect(): void {
    this.explicitlyClosed = true;
    this.generation++;
    this.clearAuthTimers();
    this.settleConnectWaiters(false, new Error('Call-state connection closed'));
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      old.close();
    }
    this._isConnected = false;
    this.unsubscribeAll();
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
      init.signal?.throwIfAborted();
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${this.liveToken()}`);
      return { ...init, headers };
    };
    const request = this.deps.fetch ?? fetch;
    let res = await request(url, withLiveAuth());
    init.signal?.throwIfAborted();
    if (res.status === 401) {
      let refreshed = false;
      try {
        refreshed = await this.refresh();
      } catch {
        refreshed = false;
      }
      if (refreshed) {
        res = await request(url, withLiveAuth());
      }
    }
    init.signal?.throwIfAborted();
    return res;
  }

  async createSession(
    sessionId: string,
    channelId: string,
    callType: string,
    hostUserId: number,
    maxParticipants = 0,
    fence?: CallWriteFence,
  ): Promise<void> {
    const res = await this.authedFetch(fencedUrl(`${this.cfg.serverUrl}/api/calls/sessions`, fence), {
      method: 'POST',
      signal: fence?.signal,
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
    fence?: CallWriteFence,
  ): Promise<void> {
    const res = await this.authedFetch(fencedUrl(`${this.cfg.serverUrl}/api/calls/sessions/${encodeURIComponent(sessionId)}/join`, fence), {
      method: 'POST',
      signal: fence?.signal,
      headers: this.headers(),
      body: JSON.stringify({ stable_user_id: stableUserId }),
    });
    if (!res.ok) throw new Error(`joinSession failed: ${res.status}`);
  }

  async leaveSession(
    sessionId: string,
    _userId: number,
    _stableUserId: string,
    fence?: CallWriteFence,
  ): Promise<void> {
    const res = await this.authedFetch(fencedUrl(`${this.cfg.serverUrl}/api/calls/sessions/${encodeURIComponent(sessionId)}/leave`, fence), {
      method: 'POST',
      signal: fence?.signal,
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

  // --- Reference-counted subscriptions, restored from authoritative snapshots ---

  subscribeToSession(sessionId: string): CallSubscriptionHandle[] {
    const entry = this.subscriptions.get(sessionId) ?? { count: 0 };
    this.subscriptions.set(sessionId, entry);
    if (entry.count++ === 0) this.subscribe(sessionId);
    let active = true;
    const handle: CallSubscriptionHandle = {
      unsubscribe: () => {
        if (!active) return;
        active = false;
        if (this.subscriptions.get(sessionId) !== entry) return;
        if (--entry.count === 0) {
          this.subscriptions.delete(sessionId);
          this.clearSession(sessionId);
          this.sendWsMessage({ type: 'unsubscribe_call', session_id: sessionId });
        }
      },
    };
    return [handle];
  }

  unsubscribeAll(): void {
    for (const id of this.subscriptions.keys()) {
      this.sendWsMessage({ type: 'unsubscribe_call', session_id: id });
      this.clearSession(id);
    }
    this.subscriptions.clear();
  }

  /** Retire the subscription identity as well as cached rows. Old handles and
   * queued snapshots may not restore a revoked group after re-add. */
  revokeSession(id: string): void {
    this.subscriptions.delete(id);
    this.clearSession(id);
    this.sendWsMessage({ type: 'unsubscribe_call', session_id: id });
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
   * Resolve after server authentication acknowledgment, not TCP open.
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
  }

  // --- Internal ---

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json' };
  }

  private liveToken(): string {
    const token = this.deps.getToken();
    if (!token) throw new Error('Call authentication lost');
    let sub: string;
    try { sub = String(JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub); }
    catch { throw new Error('Invalid call account token'); }
    if (!/^[1-9][0-9]*$/.test(sub) || (this.account !== null && this.account !== sub)) throw new Error('Call account changed');
    this.account = sub;
    return token;
  }

  private refresh(): Promise<boolean> {
    if (!this.refreshPending) {
      this.refreshPending = Promise.resolve().then(() => { this.liveToken(); return this.deps.refresh(); })
        .catch(() => false).finally(() => { this.refreshPending = null; });
    }
    return this.refreshPending;
  }

  private clearAuthTimers(): void {
    if (this.authTimer) clearTimeout(this.authTimer);
    if (this.renewalTimer) clearTimeout(this.renewalTimer);
    this.authTimer = this.renewalTimer = null;
  }

  private fail(err: Error): void {
    this.disconnect();
    this._onDisconnect?.();
    this._onError?.(err);
  }

  private authenticate(ws: WebSocket): void {
    if (this.ws !== ws) return;
    try {
      this.sentToken = this.liveToken();
      ws.send(JSON.stringify({ type: 'authenticate', token: this.sentToken }));
      if (this.authTimer) clearTimeout(this.authTimer);
      this.authTimer = setTimeout(() => { if (this.ws === ws) this.fail(new Error('Call authentication timeout')); }, 5000);
    } catch (err) { this.fail(err as Error); }
  }

  private scheduleRenewal(ws: WebSocket, expiresAt: number, delay: number): void {
    this.renewalTimer = setTimeout(async () => {
      if (this.ws !== ws) return;
      try {
        if (this.liveToken() !== this.sentToken) { this.authenticate(ws); return; }
      } catch (err) { this.fail(err as Error); return; }
      const refreshed = await this.refresh();
      if (this.ws !== ws) return;
      if (refreshed) { this.authenticate(ws); return; }
      // A transient refresh outage is not loss of a still-valid subscription.
      // Retry only within its current credential lifetime, never indefinitely.
      try { this.liveToken(); } catch (err) { this.fail(err as Error); return; }
      const remaining = expiresAt * 1000 - Date.now();
      if (remaining <= 0) { this.fail(new Error('Call credential renewal failed')); return; }
      this.scheduleRenewal(ws, expiresAt, Math.min(5000, remaining));
    }, delay);
  }

  private openWebSocket(): void {
    try {
      const wsUrl = this.cfg.serverUrl.replace(/^http/, 'ws') + '/ws';
      const generation = ++this.generation;
      this.liveToken();
      const ws = (this.deps.socket ?? (url => new WebSocket(url)))(wsUrl);
      this.ws = ws;

      ws.onopen = () => this.authenticate(ws);

      ws.onclose = async (event) => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.clearAuthTimers();
        this._isConnected = false;
        this._onDisconnect?.();
        if (event.code === 4401) {
          if (this.authRetried) { this.fail(new Error('Call authentication rejected')); return; }
          this.authRetried = true;
          const refreshed = await this.refresh();
          if (this.explicitlyClosed || this.generation !== generation || this.ws) return;
          if (refreshed) this.openWebSocket();
          else this.fail(new Error('Call authentication requires login'));
          return;
        }
        this.settleConnectWaiters(false, new Error('WebSocket closed during handshake'));
        if (!this.explicitlyClosed) this.scheduleReconnect();
      };

      ws.onerror = () => {
        if (this.ws !== ws) return;
        const err = new Error('Call-state WebSocket error');
        this._onError?.(err);
        this.settleConnectWaiters(false, err);
      };

      ws.onmessage = (ev) => {
        if (this.ws !== ws) return;
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.type === 'authenticated') {
            this.liveToken();
            if (String(msg.user_id) !== this.account || !Number.isFinite(msg.expires_at) || msg.expires_at * 1000 <= Date.now()) throw new Error('Invalid call authentication acknowledgment');
            this.clearAuthTimers();
            const wasConnected = this._isConnected;
            this._isConnected = true;
            this.authRetried = false;
            this.reconnectAttempts = 0;
            this.settleConnectWaiters(true);
            if (!wasConnected) {
              this._onConnect?.();
              for (const id of this.subscriptions.keys()) this.subscribe(id);
            }
            this.scheduleRenewal(ws, msg.expires_at, Math.max(1000, msg.expires_at * 1000 - Date.now() - 30000));
            return;
          }
          if (msg.type === 'authentication_error') return; // 4401 drives the single retry.
          if (!this._isConnected) return;
          this.liveToken();
          this.handleWsMessage(msg);
        } catch (e) {
          this.fail(new Error(`Invalid call-state message: ${e}`));
        }
      };
    } catch (e) {
      this.fail(e as Error);
    }
  }

  private sendWsMessage(msg: unknown): void {
    if (this._isConnected && this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleWsMessage(msg: any): void {
    if (msg.type === 'resync_required') {
      for (const id of this.subscriptions.keys()) this.subscribe(id);
      return;
    }
    const id = msg.session_id ?? msg.session?.session_id ?? msg.signal?.session_id;
    if (!this.subscriptions.has(id)) return;
    switch (msg.type) {
      case 'subscription_error':
        {
          const removed = membershipRevision(msg.membership_revision);
          const current = this.subscriptions.get(id)?.revision;
          if (removed && current && BigInt(removed) < BigInt(current)) break;
        }
        this.revokeSession(id);
        this._onError?.(new Error('Call subscription access denied'));
        break;
      case 'call_snapshot':
        {
          const revision = membershipRevision(msg.membership_revision);
          const entry = this.subscriptions.get(id)!;
          if (revision && entry.revision && BigInt(revision) < BigInt(entry.revision)) break;
          if (revision) entry.revision = revision;
        }
        this.handleWsMessage({ type: 'call_session_changed', session: msg.session });
        this.handleWsMessage({ type: 'call_participant_changed', session_id: id, participants: msg.participants });
        for (const signal of msg.signals ?? []) this.handleWsMessage({ type: 'call_signal_emitted', signal });
        break;
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
          if (row.signalId > (this.signalCursors.get(id) ?? 0)) {
            this.signalCursors.set(id, row.signalId);
            this._onSignal?.(row);
          }
        }
        break;
    }
  }

  private scheduleReconnect(): void {
    if (this.explicitlyClosed || this.reconnectTimer || this.ws) return;
    this.reconnectAttempts++;
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts - 1),
      RECONNECT_MAX_MS,
    );
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.openWebSocket(); }, delay);
  }

  private subscribe(id: string): void {
    this.sendWsMessage({ type: 'subscribe_call', session_id: id, since: this.signalCursors.get(id) ?? 0 });
  }
  private clearSession(id: string): void {
    this.sessionCache.delete(id); this.participantCache.delete(id); this.signalCursors.delete(id);
    this._onSessionChange?.([...this.sessionCache.values()]);
    this._onParticipantChange?.([...this.participantCache.values()].flat());
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
