import {
	sessionRepository,
	type Session
} from '../db/repositories/sessionRepository.js';
import db from '../db/database.js';
import type { SessionStoreRuntimeStats } from './sessionStore.js';
import { escapeSqlLiteral } from './stdbSyncClient.js';
import {
	StdbStoreBase,
	bumpOperation,
	makeBaseStats,
	nowMs,
	parseJsonObject,
	type StdbPrimaryStoreOptions,
	toNumber
} from './stdbCommon.js';

export class StdbPrimarySessionStore extends StdbStoreBase {
	private readonly stats = makeBaseStats();
	private readonly shadow = {
		attempted: 0,
		succeeded: 0,
		failed: 0,
		lastError: null as string | null,
		lastErrorAt: null as number | null
	};

	constructor(options: StdbPrimaryStoreOptions = {}) {
		super(options);
	}

	private parseSessions(rows: Record<string, unknown>[]): Session[] {
		const parsed: Session[] = [];
		for (const row of rows) {
			const session = parseJsonObject<Session>(row.row_json);
			if (!session) continue;
			parsed.push(session);
		}
		return parsed;
	}

	private loadLegacySession(sessionId: string): Session | null {
		return sessionRepository.findById(sessionId);
	}

	private loadLegacySessionsByUserId(userId: number): Session[] {
		return sessionRepository.findAllByUserId(userId);
	}

	private loadSession(sessionId: string, includeDeleted = false): Session | null {
		if (!includeDeleted) {
			const mirrored = this.loadLegacySession(sessionId);
			if (mirrored) return mirrored;
		}
		const deletedClause = includeDeleted ? '' : ' AND deleted = false';
		const rows = this.client.sqlRows(
			`SELECT row_json FROM state_session WHERE session_id = ${escapeSqlLiteral(sessionId)}${deletedClause} LIMIT 1`
		);
		if (rows.length === 0) return null;
		return parseJsonObject<Session>(rows[0].row_json) || null;
	}

	create(session: Session): void {
		bumpOperation(this.stats, 'create');
		this.stats.writesAttempted += 1;
		try {
			this.ingest('session', 'create', {
				sessionId: session.session_id,
				userId: session.user_id,
				isTemporary: session.is_temporary === 1,
				row: session
			});
			this.stats.writesSucceeded += 1;
		} catch (error) {
			this.recordWriteFailure(this.stats, 'create', error);
		}
		this.mirrorWrite(this.stats, this.shadow, 'create', () => {
			sessionRepository.create(session);
		});
	}

	async createAsync(session: Session): Promise<void> {
		bumpOperation(this.stats, 'createAsync');
		this.stats.writesAttempted += 1;
		try {
			await this.ingestAsync('session', 'create', {
				sessionId: session.session_id,
				userId: session.user_id,
				isTemporary: session.is_temporary === 1,
				row: session
			});
			this.stats.writesSucceeded += 1;
		} catch (error) {
			this.recordWriteFailure(this.stats, 'createAsync', error);
		}
		this.mirrorWrite(this.stats, this.shadow, 'createAsync', () => {
			sessionRepository.create(session);
		});
	}

	findById(sessionId: string): Session | null {
		bumpOperation(this.stats, 'findById');
		return this.loadSession(sessionId, false);
	}

	findByUserId(userId: number): Session | null {
		bumpOperation(this.stats, 'findByUserId');
		const mirrored = this
			.loadLegacySessionsByUserId(userId)
			.filter((session) => session.is_temporary !== 1)
			.sort((a, b) => b.created_at - a.created_at);
		if (mirrored.length > 0) {
			return mirrored[0] || null;
		}
		const rows = this.client.sqlRows(
			`SELECT row_json FROM state_session WHERE user_id = ${Math.floor(userId)} AND deleted = false LIMIT 5000`
		);
		const sessions = this.parseSessions(rows).sort((a, b) => b.created_at - a.created_at);
		return sessions[0] || null;
	}

	update(sessionId: string, updates: Partial<Session>): void {
		bumpOperation(this.stats, 'update');
		this.stats.writesAttempted += 1;
		const current = this.loadSession(sessionId, true);
		if (!current) return;
		const next: Session = { ...current, ...updates };
		try {
			this.ingest('session', 'update', {
				sessionId,
				updates,
				row: next
			});
			this.stats.writesSucceeded += 1;
		} catch (error) {
			this.recordWriteFailure(this.stats, 'update', error);
		}
		this.mirrorWrite(this.stats, this.shadow, 'update', () => {
			sessionRepository.update(sessionId, updates);
		});
	}

	delete(sessionId: string): void {
		bumpOperation(this.stats, 'delete');
		this.stats.writesAttempted += 1;
		const current = this.loadSession(sessionId, true);
		if (!current) return;
		try {
			this.ingest('session', 'delete', {
				sessionId,
				row: current
			});
			this.stats.writesSucceeded += 1;
		} catch (error) {
			this.recordWriteFailure(this.stats, 'delete', error);
		}
		this.mirrorWrite(this.stats, this.shadow, 'delete', () => {
			sessionRepository.delete(sessionId);
		});
	}

	deleteRegisteredByUserId(userId: number): number {
		bumpOperation(this.stats, 'deleteRegisteredByUserId');
		const currentSessions = this
			.loadLegacySessionsByUserId(userId)
			.filter((session) => session.is_temporary !== 1);
		if (currentSessions.length === 0) {
			const rows = this.client.sqlRows(
				`SELECT row_json FROM state_session WHERE user_id = ${Math.floor(userId)} AND deleted = false LIMIT 5000`
			);
			currentSessions.push(
				...this.parseSessions(rows).filter((session) => session.is_temporary !== 1)
			);
		}
		if (currentSessions.length === 0) return 0;

		let deleted = 0;
		for (const current of currentSessions) {
			this.stats.writesAttempted += 1;
			try {
				this.ingest('session', 'delete', {
					sessionId: current.session_id,
					row: current
				});
				this.stats.writesSucceeded += 1;
				deleted += 1;
			} catch (error) {
				this.recordWriteFailure(this.stats, 'deleteRegisteredByUserId', error);
			}
		}

		this.mirrorWrite(this.stats, this.shadow, 'deleteRegisteredByUserId', () => {
			sessionRepository.deleteRegisteredByUserId(userId);
		});
		return deleted;
	}

	async deleteRegisteredByUserIdAsync(userId: number): Promise<number> {
		bumpOperation(this.stats, 'deleteRegisteredByUserIdAsync');
		const currentSessions = this
			.loadLegacySessionsByUserId(userId)
			.filter((session) => session.is_temporary !== 1);
		if (currentSessions.length === 0) {
			const rows = this.client.sqlRows(
				`SELECT row_json FROM state_session WHERE user_id = ${Math.floor(userId)} AND deleted = false LIMIT 5000`
			);
			currentSessions.push(
				...this.parseSessions(rows).filter((session) => session.is_temporary !== 1)
			);
		}
		if (currentSessions.length === 0) return 0;

		let deleted = 0;
		for (const current of currentSessions) {
			this.stats.writesAttempted += 1;
			try {
				await this.ingestAsync('session', 'delete', {
					sessionId: current.session_id,
					row: current
				});
				this.stats.writesSucceeded += 1;
				deleted += 1;
			} catch (error) {
				this.recordWriteFailure(this.stats, 'deleteRegisteredByUserIdAsync', error);
			}
		}

		this.mirrorWrite(this.stats, this.shadow, 'deleteRegisteredByUserIdAsync', () => {
			sessionRepository.deleteRegisteredByUserId(userId);
		});
		return deleted;
	}

	cleanup(): number {
		bumpOperation(this.stats, 'cleanup');
		this.stats.writesAttempted += 1;
		const now = nowMs();
		let expired: ReturnType<typeof this.parseSessions>;
		try {
			const rows = this.client.sqlRows(
				`SELECT row_json FROM state_session WHERE deleted = false AND expires_at IS NOT NULL AND expires_at < ${Math.floor(now)} LIMIT 5000`
			);
			expired = this.parseSessions(rows);
		} catch {
			// Fallback if expires_at filter not supported by STDB schema
			const rows = this.client.sqlRows(
				'SELECT row_json FROM state_session WHERE deleted = false LIMIT 10000'
			);
			expired = this
				.parseSessions(rows)
				.filter((session) => session.expires_at != null && session.expires_at < now);
		}
		try {
			this.ingest('session', 'cleanup', {
				now,
				sessionIds: expired.map((session) => session.session_id)
			});
			this.stats.writesSucceeded += 1;
		} catch (error) {
			this.recordWriteFailure(this.stats, 'cleanup', error);
		}
		this.mirrorWrite(this.stats, this.shadow, 'cleanup', () => {
			sessionRepository.cleanup();
		});
		return expired.length;
	}

	getAll(): Session[] {
		bumpOperation(this.stats, 'getAll');
		const mirrored = sessionRepository.getAll();
		if (mirrored.length > 0) {
			return mirrored.sort((a, b) => a.session_id.localeCompare(b.session_id));
		}
		const rows = this.client.sqlRows('SELECT row_json FROM state_session WHERE deleted = false LIMIT 50000');
		return this.parseSessions(rows).sort((a, b) => a.session_id.localeCompare(b.session_id));
	}

	warmFromPrimary(limit: number): number {
		const safeLimit = Math.max(0, Math.floor(limit));
		if (safeLimit === 0) return 0;
		const existingSessionIds = new Set(
			this.client.sqlRows('SELECT session_id FROM state_session LIMIT 50000')
				.map((row) => String(row.session_id || '').trim())
				.filter((sessionId) => sessionId.length > 0)
		);

		const rows = db.prepare(`
			SELECT * FROM sessions
			ORDER BY created_at DESC
			LIMIT ?
		`).all(safeLimit) as Session[];

		let seeded = 0;
		for (const row of rows) {
			if (existingSessionIds.has(row.session_id)) continue;
			this.ingest('session', 'create', {
				sessionId: row.session_id,
				userId: row.user_id,
				isTemporary: row.is_temporary === 1,
				row
			});
			seeded += 1;
		}

		this.stats.operations.warmup = (this.stats.operations.warmup || 0) + 1;
		this.stats.operations.warmup_rows = seeded;
		return seeded;
	}

	getRuntimeStats(): SessionStoreRuntimeStats {
		return {
			mode: 'stdb_primary',
			writesAttempted: this.stats.writesAttempted,
			writesSucceeded: this.stats.writesSucceeded,
			writesFailed: this.stats.writesFailed,
			lastError: this.stats.lastError,
			lastErrorAt: this.stats.lastErrorAt,
			operations: { ...this.stats.operations },
			shadow: {
				enabled: this.mirrorLegacyWrites,
				label: this.mirrorLegacyWrites ? 'legacy-mirror' : 'none',
				writesAttempted: this.shadow.attempted,
				writesSucceeded: this.shadow.succeeded,
				writesFailed: this.shadow.failed,
				lastError: this.shadow.lastError,
				lastErrorAt: this.shadow.lastErrorAt
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
	}
}
