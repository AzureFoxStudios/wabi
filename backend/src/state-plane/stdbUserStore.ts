import type { RegisteredUser } from './records.js';
import type { UserStoreRuntimeStats } from './storeTypes.js';
import {
	StdbStoreBase,
	bumpOperation,
	makeBaseStats,
	parseJsonObject,
	type StdbPrimaryStoreOptions,
	toNumber
} from './stdbCommon.js';
import { escapeSqlLiteral } from './stdbSyncClient.js';

type FeatureState = 'unknown' | 'enabled' | 'disabled';

/**
 * Keep the full auth record in the shared state plane.
 * After the SQLite repo cutover, every backend must be able to verify
 * registered-user passwords from STDB-backed user rows.
 */
function cloneRowForStdb<T extends Record<string, unknown>>(row: T): T {
	return { ...row };
}

export class StdbPrimaryUserStore extends StdbStoreBase {
	private readonly stats = makeBaseStats();
	private static readonly FEATURE_RETRY_MS = 60_000;
	private readonly featureState: {
		userMeta: FeatureState;
		usernameLookup: FeatureState;
		handleLookup: FeatureState;
	} = {
		userMeta: 'unknown',
		usernameLookup: 'unknown',
		handleLookup: 'unknown'
	};
	private readonly featureDisabledAt: Record<string, number> = {};

	constructor(options: StdbPrimaryStoreOptions = {}) {
		super(options);
	}

	private parseUsers(rows: Record<string, unknown>[]): RegisteredUser[] {
		const parsed: RegisteredUser[] = [];
		for (const row of rows) {
			const user = parseJsonObject<RegisteredUser>(row.row_json);
			if (!user) continue;
			parsed.push(user);
		}
		return parsed;
	}

	private tryFeatureSqlRows(
		feature: 'userMeta' | 'usernameLookup' | 'handleLookup',
		query: string
	): Record<string, unknown>[] | null {
		if (this.featureState[feature] === 'disabled') {
			const disabledAt = this.featureDisabledAt[feature] || 0;
			if (Date.now() - disabledAt < StdbPrimaryUserStore.FEATURE_RETRY_MS) {
				return null;
			}
			this.featureState[feature] = 'unknown';
		}

		try {
			const rows = this.client.sqlRows(query) as Record<string, unknown>[];
			if (this.featureState[feature] === 'unknown') {
				this.featureState[feature] = 'enabled';
			}
			return rows;
		} catch (error) {
			if (this.featureState[feature] !== 'disabled') {
				this.featureState[feature] = 'disabled';
				this.featureDisabledAt[feature] = Date.now();
				const detail = error instanceof Error ? error.message : String(error);
				console.warn(`[StatePlane] STDB user feature "${feature}" unavailable; falling back (${detail})`);
			}
			return null;
		}
	}

	private loadUserById(userId: number, includeDeleted = false): RegisteredUser | null {
		const deletedClause = includeDeleted ? '' : ' AND deleted = false';
		const rows = this.client.sqlRows(
			`SELECT row_json FROM state_user WHERE user_id = ${Math.floor(userId)}${deletedClause} LIMIT 1`
		);
		if (rows.length === 0) return null;
		return parseJsonObject<RegisteredUser>(rows[0].row_json) || null;
	}

	private nextUserId(): number {
		const metaRows = this.tryFeatureSqlRows(
			'userMeta',
			"SELECT next_user_id FROM state_user_meta WHERE meta_key = 'default' LIMIT 1"
		);
		if (metaRows && metaRows.length > 0) {
			const candidate = toNumber(metaRows[0].next_user_id);
			if (candidate > 0) return candidate;
		}

		try {
			const maxRows = this.client.sqlRows('SELECT MAX(user_id) AS max_id FROM state_user LIMIT 1');
			const maxId = maxRows.length > 0 ? toNumber(maxRows[0].max_id) : 0;
			if (maxId > 0) return maxId + 1;
		} catch {
			// MAX() may not be supported; fall through
		}
		return 1;
	}

	create(user: Omit<RegisteredUser, 'user_id'>): RegisteredUser {
		bumpOperation(this.stats, 'create');
		this.stats.writesAttempted += 1;
		const created: RegisteredUser = {
			...user,
			user_id: this.nextUserId(),
			is_active: user.is_active ?? 1
		};
		try {
			this.ingest('user', 'create', {
				userId: created.user_id,
				username: created.username,
				handle: created.handle || null,
				row: cloneRowForStdb(created)
			});
			this.stats.writesSucceeded += 1;
		} catch (error) {
			this.recordWriteFailure(this.stats, 'create', error);
		}
		return created;
	}

	async createAsync(user: Omit<RegisteredUser, 'user_id'>): Promise<RegisteredUser> {
		bumpOperation(this.stats, 'createAsync');
		this.stats.writesAttempted += 1;
		const created: RegisteredUser = {
			...user,
			user_id: this.nextUserId(),
			is_active: user.is_active ?? 1
		};
		try {
			await this.ingestAsync('user', 'create', {
				userId: created.user_id,
				username: created.username,
				handle: created.handle || null,
				row: cloneRowForStdb(created)
			});
			this.stats.writesSucceeded += 1;
		} catch (error) {
			this.recordWriteFailure(this.stats, 'createAsync', error);
		}
		return created;
	}

	findByUsername(username: string): RegisteredUser | null {
		bumpOperation(this.stats, 'findByUsername');
		const normalized = (username || '').trim().toLowerCase();
		if (!normalized) return null;

		const lookupRows = this.tryFeatureSqlRows(
			'usernameLookup',
			`SELECT user_id FROM state_user_username WHERE username_lc = ${escapeSqlLiteral(normalized)} LIMIT 1`
		);
		if (lookupRows && lookupRows.length > 0) {
			const userId = toNumber(lookupRows[0].user_id);
			if (userId > 0) {
				const byId = this.loadUserById(userId, false);
				if (byId) return byId;
			}
		}

		return null;
	}

	findByHandle(handle: string): RegisteredUser | null {
		bumpOperation(this.stats, 'findByHandle');
		const normalized = handle.replace(/^@/, '').toLowerCase();
		if (!normalized) return null;

		const lookupRows = this.tryFeatureSqlRows(
			'handleLookup',
			`SELECT user_id FROM state_user_handle WHERE handle_lc = ${escapeSqlLiteral(normalized)} LIMIT 1`
		);
		if (lookupRows && lookupRows.length > 0) {
			const userId = toNumber(lookupRows[0].user_id);
			if (userId > 0) {
				const byId = this.loadUserById(userId, false);
				if (byId) return byId;
			}
		}

		return null;
	}

	findByHandleOrUsername(identifier: string): RegisteredUser | null {
		const byHandle = this.findByHandle(identifier);
		if (byHandle) return byHandle;
		return this.findByUsername(identifier);
	}

	findById(userId: number): RegisteredUser | null {
		bumpOperation(this.stats, 'findById');
		return this.loadUserById(userId, false);
	}

	update(userId: number, updates: Partial<RegisteredUser>): void {
		bumpOperation(this.stats, 'update');
		this.stats.writesAttempted += 1;
		const current = this.loadUserById(userId, true);
		if (!current) return;
		const next: RegisteredUser = {
			...current,
			...updates,
			user_id: userId
		};
		try {
			this.ingest('user', 'update', {
				userId,
				updates: cloneRowForStdb(updates as Record<string, unknown>),
				row: cloneRowForStdb(next)
			});
			this.stats.writesSucceeded += 1;
		} catch (error) {
			this.recordWriteFailure(this.stats, 'update', error);
		}
	}

	delete(userId: number): void {
		bumpOperation(this.stats, 'delete');
		this.stats.writesAttempted += 1;
		const current = this.loadUserById(userId, true);
		if (!current) return;
		const next: RegisteredUser = { ...current, is_active: 0 };
		try {
			this.ingest('user', 'delete', {
				userId,
				row: cloneRowForStdb(next)
			});
			this.stats.writesSucceeded += 1;
		} catch (error) {
			this.recordWriteFailure(this.stats, 'delete', error);
		}
	}

	getAll(): RegisteredUser[] {
		bumpOperation(this.stats, 'getAll');
		const rows = this.client.sqlRows('SELECT row_json FROM state_user WHERE deleted = false AND active = true LIMIT 50000');
		return this.parseUsers(rows).sort((a, b) => (a.user_id || 0) - (b.user_id || 0));
	}

	getRuntimeStats(): UserStoreRuntimeStats {
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
