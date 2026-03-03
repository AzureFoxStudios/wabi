import {
	sessionRepository,
	type Session
} from '../db/repositories/sessionRepository.js';
import db from '../db/database.js';
import { type StatePlaneOutbox } from './outbox.js';

interface ShadowStats {
	enabled: boolean;
	label: string;
	writesAttempted: number;
	writesSucceeded: number;
	writesFailed: number;
	lastError: string | null;
	lastErrorAt: number | null;
}

interface ParityStats {
	samples: number;
	mismatches: number;
	lastMismatch: string | null;
	lastMismatchAt: number | null;
}

interface ReadSwitchStats {
	enabled: boolean;
	canaryPercent: number;
	attempts: number;
	canaryRouted: number;
	shadowServed: number;
	fallbacks: number;
	shadowErrors: number;
	mismatches: number;
	lastFallbackReason: string | null;
	lastFallbackAt: number | null;
}

export interface SessionStoreRuntimeStats {
	mode: 'legacy' | 'dual_write' | 'stdb_primary';
	writesAttempted: number;
	writesSucceeded: number;
	writesFailed: number;
	lastError: string | null;
	lastErrorAt: number | null;
	operations: Record<string, number>;
	shadow: ShadowStats;
	parity: ParityStats;
	readSwitch: ReadSwitchStats;
}

export interface StateSessionStoreOptions {
	dualWriteEnabled?: boolean;
	label?: string;
	paritySampleRate?: number;
	strictShadow?: boolean;
	readShadowEnabled?: boolean;
	readCanaryPercent?: number;
}

function normalizeSampleRate(input: number | undefined): number {
	if (!Number.isFinite(input)) return 0.1;
	return Math.max(0, Math.min(1, input as number));
}

function normalizeCanaryPercent(input: number | undefined): number {
	if (!Number.isFinite(input)) return 0;
	return Math.max(0, Math.min(100, Math.floor(input as number)));
}

function compareSessions(a: Session | null, b: Session | null): string | null {
	if (!a && !b) return null;
	if (!a || !b) return `presence_mismatch primary=${Boolean(a)} shadow=${Boolean(b)}`;

	if (a.session_id !== b.session_id) return 'session_id_mismatch';
	if ((a.user_id || null) !== (b.user_id || null)) return 'user_id_mismatch';
	if (a.username !== b.username) return 'username_mismatch';
	if (a.color !== b.color) return 'color_mismatch';
	if ((a.profile_picture || null) !== (b.profile_picture || null)) return 'profile_picture_mismatch';
	if (a.created_at !== b.created_at) return 'created_at_mismatch';
	if ((a.expires_at || null) !== (b.expires_at || null)) return 'expires_at_mismatch';
	if (a.is_temporary !== b.is_temporary) return 'is_temporary_mismatch';
	if ((a.socket_id || null) !== (b.socket_id || null)) return 'socket_id_mismatch';
	if ((a.last_seen || null) !== (b.last_seen || null)) return 'last_seen_mismatch';
	return null;
}

export class StateSessionStore {
	private readonly dualWriteEnabled: boolean;
	private readonly paritySampleRate: number;
	private readonly label: string;
	private readonly strictShadow: boolean;
	private readonly readShadowEnabled: boolean;
	private readonly readCanaryPercent: number;
	private shadowSessions = new Map<string, Session>();
	private stats: SessionStoreRuntimeStats = {
		mode: 'legacy',
		writesAttempted: 0,
		writesSucceeded: 0,
		writesFailed: 0,
		lastError: null,
		lastErrorAt: null,
		operations: {},
		shadow: {
			enabled: false,
			label: 'none',
			writesAttempted: 0,
			writesSucceeded: 0,
			writesFailed: 0,
			lastError: null,
			lastErrorAt: null
		},
		parity: {
			samples: 0,
			mismatches: 0,
			lastMismatch: null,
			lastMismatchAt: null
		},
		readSwitch: {
			enabled: false,
			canaryPercent: 0,
			attempts: 0,
			canaryRouted: 0,
			shadowServed: 0,
			fallbacks: 0,
			shadowErrors: 0,
			mismatches: 0,
			lastFallbackReason: null,
			lastFallbackAt: null
		}
	};

	constructor(
		private readonly outbox: StatePlaneOutbox | null = null,
		options: StateSessionStoreOptions = {}
	) {
		this.dualWriteEnabled = options.dualWriteEnabled === true;
		this.label = options.label || 'session-shadow';
		this.paritySampleRate = normalizeSampleRate(options.paritySampleRate);
		this.strictShadow = options.strictShadow === true;
		this.readShadowEnabled = options.readShadowEnabled === true;
		this.readCanaryPercent = normalizeCanaryPercent(options.readCanaryPercent);

		this.stats.mode = this.dualWriteEnabled ? 'dual_write' : 'legacy';
		this.stats.shadow.enabled = this.dualWriteEnabled;
		this.stats.shadow.label = this.dualWriteEnabled ? this.label : 'none';
		this.stats.readSwitch.enabled = this.dualWriteEnabled && this.readShadowEnabled;
		this.stats.readSwitch.canaryPercent = this.readCanaryPercent;
	}

	private cloneSession(session: Session): Session {
		return { ...session };
	}

	private trackPrimarySuccess(op: string): void {
		this.stats.writesAttempted += 1;
		this.stats.writesSucceeded += 1;
		this.stats.operations[op] = (this.stats.operations[op] || 0) + 1;
	}

	private trackPrimaryFailure(op: string, error: unknown): void {
		this.stats.writesAttempted += 1;
		this.stats.writesFailed += 1;
		this.stats.operations[op] = (this.stats.operations[op] || 0) + 1;
		this.stats.lastErrorAt = Date.now();
		this.stats.lastError = error instanceof Error ? error.message : String(error);
	}

	private shadowBestEffort(op: string, fn: () => void): void {
		if (!this.dualWriteEnabled) return;
		this.stats.shadow.writesAttempted += 1;
		try {
			fn();
			this.stats.shadow.writesSucceeded += 1;
		} catch (error) {
			this.stats.shadow.writesFailed += 1;
			this.stats.shadow.lastErrorAt = Date.now();
			this.stats.shadow.lastError = error instanceof Error ? error.message : String(error);
			const key = `shadow:${op}`;
			if (!this.stats.operations[key]) {
				this.stats.operations[key] = 1;
				console.warn(`[StatePlane] Session shadow operation failed (${op}); continuing with primary store`, error);
			} else {
				this.stats.operations[key] += 1;
			}
			if (this.strictShadow) {
				throw error instanceof Error ? error : new Error(String(error));
			}
		}
	}

	private shouldRunParitySample(): boolean {
		return this.dualWriteEnabled && this.paritySampleRate > 0 && Math.random() <= this.paritySampleRate;
	}

	private shouldRunReadCanary(): boolean {
		if (!this.dualWriteEnabled) return false;
		if (!this.readShadowEnabled) return false;
		if (this.readCanaryPercent <= 0) return false;
		return Math.random() * 100 < this.readCanaryPercent;
	}

	private recordReadAttempt(): void {
		this.stats.readSwitch.attempts += 1;
	}

	private recordReadCanaryRoute(): void {
		this.stats.readSwitch.canaryRouted += 1;
	}

	private recordReadServedByShadow(): void {
		this.stats.readSwitch.shadowServed += 1;
	}

	private recordReadFallback(reason: string): void {
		this.stats.readSwitch.fallbacks += 1;
		this.stats.readSwitch.lastFallbackReason = reason;
		this.stats.readSwitch.lastFallbackAt = Date.now();
	}

	private recordReadShadowError(op: string, error: unknown): void {
		this.stats.readSwitch.shadowErrors += 1;
		this.recordReadFallback(`error:${op}`);
		const key = `read_shadow_error:${op}`;
		if (!this.stats.operations[key]) {
			this.stats.operations[key] = 1;
			console.warn(`[StatePlane] Session shadow read failed (${op}); falling back to primary`, error);
			return;
		}
		this.stats.operations[key] += 1;
	}

	private recordParitySample(): void {
		this.stats.parity.samples += 1;
	}

	private recordParityMismatch(reason: string): void {
		this.stats.parity.mismatches += 1;
		this.stats.parity.lastMismatch = reason;
		this.stats.parity.lastMismatchAt = Date.now();
	}

	private appendOutbox(operation: string, payload: Record<string, unknown>): void {
		this.outbox?.append({
			timestamp: Date.now(),
			entity: 'session',
			operation,
			payload
		});
	}

	create(session: Session): void {
		try {
			sessionRepository.create(session);
			this.trackPrimarySuccess('create');
			this.shadowBestEffort('create', () => {
				this.shadowSessions.set(session.session_id, this.cloneSession(session));
			});
			this.appendOutbox('create', {
				sessionId: session.session_id,
				userId: session.user_id || null,
				isTemporary: session.is_temporary
			});
		} catch (error) {
			this.trackPrimaryFailure('create', error);
			throw error;
		}
	}

	findById(sessionId: string): Session | null {
		this.recordReadAttempt();
		const primary = sessionRepository.findById(sessionId);
		if (this.shouldRunReadCanary()) {
			this.recordReadCanaryRoute();
			this.recordParitySample();
			try {
				const shadow = this.shadowSessions.get(sessionId) || null;
				if (!shadow && primary) {
					this.shadowSessions.set(sessionId, this.cloneSession(primary));
					this.recordReadFallback('cold:findById');
					return primary;
				}
				const mismatch = compareSessions(primary, shadow);
				if (mismatch) {
					this.recordParityMismatch(`read_canary:findById(${sessionId}): ${mismatch}`);
					this.stats.readSwitch.mismatches += 1;
					this.recordReadFallback('mismatch:findById');
					return primary;
				}
				if (shadow) {
					this.recordReadServedByShadow();
					return this.cloneSession(shadow);
				}
				return shadow;
			} catch (error) {
				this.recordReadShadowError('findById', error);
				return primary;
			}
		}
		if (!this.shouldRunParitySample()) return primary;

		this.recordParitySample();
		const shadow = this.shadowSessions.get(sessionId) || null;
		if (!shadow && primary) {
			this.shadowSessions.set(sessionId, this.cloneSession(primary));
			return primary;
		}
		const mismatch = compareSessions(primary, shadow);
		if (mismatch) {
			this.recordParityMismatch(`findById(${sessionId}): ${mismatch}`);
		}
		return primary;
	}

	findByUserId(userId: number): Session | null {
		this.recordReadAttempt();
		const primary = sessionRepository.findByUserId(userId);
		if (this.shouldRunReadCanary()) {
			this.recordReadCanaryRoute();
			this.recordParitySample();
			try {
				const shadow = Array.from(this.shadowSessions.values())
					.filter((session) => session.user_id === userId)
					.sort((a, b) => b.created_at - a.created_at)[0] || null;
				if (!shadow && primary) {
					this.shadowSessions.set(primary.session_id, this.cloneSession(primary));
					this.recordReadFallback('cold:findByUserId');
					return primary;
				}
				const mismatch = compareSessions(primary, shadow);
				if (mismatch) {
					this.recordParityMismatch(`read_canary:findByUserId(${userId}): ${mismatch}`);
					this.stats.readSwitch.mismatches += 1;
					this.recordReadFallback('mismatch:findByUserId');
					return primary;
				}
				if (shadow) {
					this.recordReadServedByShadow();
					return this.cloneSession(shadow);
				}
				return shadow;
			} catch (error) {
				this.recordReadShadowError('findByUserId', error);
				return primary;
			}
		}
		if (!this.shouldRunParitySample()) return primary;

		this.recordParitySample();
		const shadow = Array.from(this.shadowSessions.values())
			.filter((session) => session.user_id === userId)
			.sort((a, b) => b.created_at - a.created_at)[0] || null;

		if (!shadow && primary) {
			this.shadowSessions.set(primary.session_id, this.cloneSession(primary));
			return primary;
		}

		const mismatch = compareSessions(primary, shadow);
		if (mismatch) {
			this.recordParityMismatch(`findByUserId(${userId}): ${mismatch}`);
		}
		return primary;
	}

	update(sessionId: string, updates: Partial<Session>): void {
		try {
			sessionRepository.update(sessionId, updates);
			this.trackPrimarySuccess('update');
			this.shadowBestEffort('update', () => {
				const current = this.shadowSessions.get(sessionId) || sessionRepository.findById(sessionId);
				if (!current) return;
				const merged = { ...current, ...updates };
				this.shadowSessions.set(sessionId, this.cloneSession(merged));
			});
			this.appendOutbox('update', {
				sessionId,
				updatedFields: Object.keys(updates)
			});
		} catch (error) {
			this.trackPrimaryFailure('update', error);
			throw error;
		}
	}

	delete(sessionId: string): void {
		try {
			sessionRepository.delete(sessionId);
			this.trackPrimarySuccess('delete');
			this.shadowBestEffort('delete', () => {
				this.shadowSessions.delete(sessionId);
			});
			this.appendOutbox('delete', { sessionId });
		} catch (error) {
			this.trackPrimaryFailure('delete', error);
			throw error;
		}
	}

	cleanup(): number {
		const deleted = sessionRepository.cleanup();
		this.trackPrimarySuccess('cleanup');
		this.shadowBestEffort('cleanup', () => {
			const now = Date.now();
			for (const [sessionId, session] of this.shadowSessions.entries()) {
				if (session.expires_at != null && session.expires_at < now) {
					this.shadowSessions.delete(sessionId);
				}
			}
		});
		this.appendOutbox('cleanup', { deleted });
		return deleted;
	}

	getAll(): Session[] {
		this.recordReadAttempt();
		const primary = sessionRepository.getAll();
		if (this.shouldRunReadCanary()) {
			this.recordReadCanaryRoute();
			this.recordParitySample();
			try {
				const shadow = Array.from(this.shadowSessions.values()).sort((a, b) => a.session_id.localeCompare(b.session_id));
				if (shadow.length === 0 && primary.length > 0) {
					for (const session of primary) {
						this.shadowSessions.set(session.session_id, this.cloneSession(session));
					}
					this.recordReadFallback('cold:getAll');
					return primary;
				}
				const orderedPrimary = [...primary].sort((a, b) => a.session_id.localeCompare(b.session_id));
				if (orderedPrimary.length !== shadow.length) {
					this.recordParityMismatch(`read_canary:getAll: row_count_mismatch primary=${orderedPrimary.length} shadow=${shadow.length}`);
					this.stats.readSwitch.mismatches += 1;
					this.recordReadFallback('mismatch:getAll');
					return primary;
				}
				for (let i = 0; i < orderedPrimary.length; i += 1) {
					const mismatch = compareSessions(orderedPrimary[i], shadow[i]);
					if (mismatch) {
						this.recordParityMismatch(`read_canary:getAll index=${i}: ${mismatch}`);
						this.stats.readSwitch.mismatches += 1;
						this.recordReadFallback('mismatch:getAll');
						return primary;
					}
				}
				this.recordReadServedByShadow();
				return shadow.map((session) => this.cloneSession(session));
			} catch (error) {
				this.recordReadShadowError('getAll', error);
				return primary;
			}
		}
		if (!this.shouldRunParitySample()) return primary;

		this.recordParitySample();
		const shadow = Array.from(this.shadowSessions.values()).sort((a, b) => a.session_id.localeCompare(b.session_id));
		if (shadow.length === 0 && primary.length > 0) {
			for (const session of primary) {
				this.shadowSessions.set(session.session_id, this.cloneSession(session));
			}
			return primary;
		}

		const orderedPrimary = [...primary].sort((a, b) => a.session_id.localeCompare(b.session_id));
		if (orderedPrimary.length !== shadow.length) {
			this.recordParityMismatch(`getAll: row_count_mismatch primary=${orderedPrimary.length} shadow=${shadow.length}`);
			return primary;
		}
		for (let i = 0; i < orderedPrimary.length; i += 1) {
			const mismatch = compareSessions(orderedPrimary[i], shadow[i]);
			if (mismatch) {
				this.recordParityMismatch(`getAll index=${i}: ${mismatch}`);
				break;
			}
		}
		return primary;
	}

	warmFromPrimary(limit: number): number {
		if (!this.dualWriteEnabled) return 0;
		const safeLimit = Math.max(0, Math.floor(limit));
		if (safeLimit === 0) return 0;

		const rows = db.prepare(`
			SELECT * FROM sessions
			ORDER BY created_at DESC
			LIMIT ?
		`).all(safeLimit) as Session[];

		this.shadowBestEffort('warmup', () => {
			this.shadowSessions.clear();
			for (const row of rows) {
				this.shadowSessions.set(row.session_id, this.cloneSession(row));
			}
		});

		this.stats.operations.warmup = (this.stats.operations.warmup || 0) + 1;
		this.stats.operations.warmup_rows = rows.length;
		return rows.length;
	}

	getRuntimeStats(): SessionStoreRuntimeStats {
		return {
			mode: this.stats.mode,
			writesAttempted: this.stats.writesAttempted,
			writesSucceeded: this.stats.writesSucceeded,
			writesFailed: this.stats.writesFailed,
			lastError: this.stats.lastError,
			lastErrorAt: this.stats.lastErrorAt,
			operations: { ...this.stats.operations },
			shadow: { ...this.stats.shadow },
			parity: { ...this.stats.parity },
			readSwitch: { ...this.stats.readSwitch }
		};
	}
}
