import type { Session } from './records.js';
import type { SessionStoreRuntimeStats } from './storeTypes.js';
import { escapeSqlLiteral } from './stdbSyncClient.js';
import {
	StdbStoreBase,
	bumpOperation,
	makeBaseStats,
	nowMs,
	parseJsonObject,
	type StdbPrimaryStoreOptions
} from './stdbCommon.js';

export class StdbPrimarySessionStore extends StdbStoreBase {
	private readonly stats = makeBaseStats();

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

	private loadActiveSessions(limit = 5000): Session[] {
		const rows = this.client.sqlRows(
			`SELECT row_json FROM state_session WHERE deleted = false LIMIT ${Math.max(1, Math.floor(limit))}`
		);
		return this.parseSessions(rows);
	}

	private loadSession(sessionId: string, includeDeleted = false): Session | null {
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
	}

	findById(sessionId: string): Session | null {
		bumpOperation(this.stats, 'findById');
		return this.loadSession(sessionId, false);
	}

	findByUserId(userId: number): Session | null {
		bumpOperation(this.stats, 'findByUserId');
		const normalizedUserId = Math.floor(userId);
		const sessions = this.loadActiveSessions()
			.filter((session) => session.user_id === normalizedUserId)
			.filter((session) => session.is_temporary !== 1)
			.sort((a, b) => b.created_at - a.created_at);
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
	}

	private loadRegisteredSessionsByUserId(userId: number): Session[] {
		const normalizedUserId = Math.floor(userId);
		return this.loadActiveSessions()
			.filter((session) => session.user_id === normalizedUserId)
			.filter((session) => session.is_temporary !== 1);
	}

	deleteRegisteredByUserId(userId: number): number {
		bumpOperation(this.stats, 'deleteRegisteredByUserId');
		const currentSessions = this.loadRegisteredSessionsByUserId(userId);
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
		return deleted;
	}

	async deleteRegisteredByUserIdAsync(userId: number): Promise<number> {
		bumpOperation(this.stats, 'deleteRegisteredByUserIdAsync');
		const currentSessions = this.loadRegisteredSessionsByUserId(userId);
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
		return deleted;
	}

	cleanup(): number {
		bumpOperation(this.stats, 'cleanup');
		this.stats.writesAttempted += 1;
		const now = nowMs();
		let expired: Session[];
		try {
			const rows = this.client.sqlRows(
				`SELECT row_json FROM state_session WHERE deleted = false AND expires_at IS NOT NULL AND expires_at < ${Math.floor(now)} LIMIT 5000`
			);
			expired = this.parseSessions(rows);
		} catch {
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
		return expired.length;
	}

	getAll(): Session[] {
		bumpOperation(this.stats, 'getAll');
		const rows = this.client.sqlRows('SELECT row_json FROM state_session WHERE deleted = false LIMIT 50000');
		return this.parseSessions(rows).sort((a, b) => a.session_id.localeCompare(b.session_id));
	}

	getRuntimeStats(): SessionStoreRuntimeStats {
		return {
			mode: 'stdb_primary',
			writesAttempted: this.stats.writesAttempted,
			writesSucceeded: this.stats.writesSucceeded,
			writesFailed: this.stats.writesFailed,
			lastError: this.stats.lastError,
			lastErrorAt: this.stats.lastErrorAt,
			operations: { ...this.stats.operations }
		};
	}
}
