/**
 * STDB call-state connection — typed wrapper over generated SDK bindings.
 *
 * Generated code lives in ./stdb_bindings/ (produced by `spacetime generate`).
 * This file is the thin layer that Wabi's calling_impl.ts actually imports.
 */

import {
  DbConnection,
  type SubscriptionHandle,
} from './stdb_bindings/index';

/* ───── row types (match generated schema exactly) ───── */

export interface StateCallSessionRow {
  sessionId: string;
  channelId: string;
  callType: string;
  hostUserId: bigint | null;
  startedAt: bigint;
  endedAt: bigint | null;
  transport: string;
  maxParticipants: bigint;
  active: boolean;
  lastUpdatedAt: unknown; // Timestamp
}

export interface StateCallParticipantRow {
  participantKey: string;
  sessionId: string;
  userId: bigint;
  stableUserId: string;
  joinedAt: bigint;
  leftAt: bigint | null;
  isHost: boolean;
  muted: boolean;
  videoEnabled: boolean;
  lastUpdatedAt: unknown; // Timestamp
}

export interface StateCallSignalRow {
  signalId: number;
  sessionId: string;
  fromUserId: bigint;
  signalType: string;
  targetUserId: bigint | null;
  payload: string;
  createdAt: unknown; // Timestamp
}

/* ───── config ───── */

export interface StdbCallConfig {
  host: string;          // e.g. "ws://localhost:3100" or "wss://wabi.example.com"
  database: string;      // e.g. "wabi-state-benchmark-v2"
  token?: string;        // bearer token from Wabi auth
}

/* ───── typed connection wrapper ───── */

export class StdbCallState {
  private conn: DbConnection | null = null;
  private handles: SubscriptionHandle[] = [];
  private _onSessionChange?: (rows: StateCallSessionRow[]) => void;
  private _onParticipantChange?: (rows: StateCallParticipantRow[]) => void;
  private _onSignal?: (row: StateCallSignalRow) => void;
  private _onConnect?: () => void;
  private _onDisconnect?: () => void;
  private _onError?: (err: Error) => void;

  constructor(private cfg: StdbCallConfig) {}

  /** Open WebSocket to STDB and wire table callbacks. */
  connect(): void {
    if (this.conn?.isActive) return;

    const builder = DbConnection.builder();
    builder.withUri(this.cfg.host);
    builder.withDatabaseName(this.cfg.database);
    if (this.cfg.token) builder.withToken(this.cfg.token);
    builder.withCompression('none');

    builder.onConnect((_ctx, _identity, _token) => {
      this._onConnect?.();
    });
    builder.onConnectError((_ctx, error) => {
      this._onError?.(error);
    });
    builder.onDisconnect((_ctx) => {
      this._onDisconnect?.();
    });

    this.conn = builder.build();

    // Wire table-level callbacks (snake_case accessors on db)
    this.conn.db.state_call_session.onInsert((_ctx, row) => this._emitSessionChange());
    this.conn.db.state_call_session.onUpdate((_ctx, _old, _new) => this._emitSessionChange());
    this.conn.db.state_call_session.onDelete((_ctx, _row) => this._emitSessionChange());

    this.conn.db.state_call_participant.onInsert((_ctx, _row) => this._emitParticipantChange());
    this.conn.db.state_call_participant.onUpdate((_ctx, _old, _new) => this._emitParticipantChange());
    this.conn.db.state_call_participant.onDelete((_ctx, _row) => this._emitParticipantChange());

    this.conn.db.state_call_signal.onInsert((_ctx, row) => this._onSignal?.(row as unknown as StateCallSignalRow));
  }

  disconnect(): void {
    this.conn?.disconnect();
    this.conn = null;
  }

  get isConnected(): boolean {
    return this.conn?.isActive ?? false;
  }

  /** Subscribe to rows for a specific call session. */
  subscribeToSession(sessionId: string): SubscriptionHandle[] {
    if (!this.conn) return [];
    const sub = this.conn.subscriptionBuilder();
    const h1 = sub.subscribe(`SELECT * FROM state_call_session WHERE session_id = '${sessionId}'`);
    const h2 = sub.subscribe(`SELECT * FROM state_call_participant WHERE session_id = '${sessionId}'`);
    const h3 = sub.subscribe(`SELECT * FROM state_call_signal WHERE session_id = '${sessionId}'`);
    this.handles.push(h1, h2, h3);
    return [h1, h2, h3];
  }

  unsubscribeAll(): void {
    for (const h of this.handles) {
      try { h.unsubscribe(); } catch (_) { /* ignore */ }
    }
    this.handles = [];
  }

  /* ───── reducers (single object argument matching generated schema) ───── */

  createSession(sessionId: string, channelId: string, callType: string, hostUserId: number, maxParticipants = 0): void {
    this.conn?.reducers.callSessionCreate({
      sessionId,
      channelId,
      callType,
      hostUserId: BigInt(hostUserId),
      maxParticipants: BigInt(maxParticipants),
    });
  }

  joinSession(sessionId: string, userId: number, stableUserId: string): void {
    this.conn?.reducers.callSessionJoin({
      sessionId,
      userId: BigInt(userId),
      stableUserId,
    });
  }

  leaveSession(sessionId: string, userId: number, _stableUserId: string): void {
    this.conn?.reducers.callSessionLeave({
      sessionId,
      userId: BigInt(userId),
    });
  }

  endSession(sessionId: string, _userId?: number, _stableUserId?: string): void {
    this.conn?.reducers.callSessionEnd({ sessionId });
  }

  emitSignal(sessionId: string, userId: number, signalType: string, payloadJson: string): void {
    this.conn?.reducers.callSignalEmit({
      sessionId,
      signalType,
      targetUserId: userId ? BigInt(userId) : undefined,
      payload: payloadJson,
    });
  }

  /* ───── cache accessors (use iter() + spread) ───── */

  getSession(sessionId: string): StateCallSessionRow | undefined {
    if (!this.conn) return undefined;
    return [...this.conn.db.state_call_session.iter()].find((r) => r.sessionId === sessionId);
  }

  getParticipants(sessionId: string): StateCallParticipantRow[] {
    if (!this.conn) return [];
    return [...this.conn.db.state_call_participant.iter()].filter((r) => r.sessionId === sessionId);
  }

  getSignals(sessionId: string, since: bigint = 0n): any[] {
    if (!this.conn) return [];
    return [...this.conn.db.state_call_signal.iter()].filter(
      (r: any) => r.sessionId === sessionId && (r.createdAt as unknown as bigint) > since
    );
  }

  /* ───── event handlers ───── */

  onConnect(cb: () => void) { this._onConnect = cb; }
  onDisconnect(cb: () => void) { this._onDisconnect = cb; }
  onError(cb: (err: Error) => void) { this._onError = cb; }
  onSessionChange(cb: (rows: StateCallSessionRow[]) => void) { this._onSessionChange = cb; }
  onParticipantChange(cb: (rows: StateCallParticipantRow[]) => void) { this._onParticipantChange = cb; }
  onSignal(cb: (row: StateCallSignalRow) => void) { this._onSignal = cb; }

  private _emitSessionChange() {
    if (!this.conn) return;
    this._onSessionChange?.([...this.conn.db.state_call_session.iter()] as unknown as StateCallSessionRow[]);
  }

  private _emitParticipantChange() {
    if (!this.conn) return;
    this._onParticipantChange?.([...this.conn.db.state_call_participant.iter()] as unknown as StateCallParticipantRow[]);
  }
}
