import {
	userRepository,
	type RegisteredUser
} from '../db/repositories/userRepository.js';
import db from '../db/database.js';
import type { UserStoreRuntimeStats } from './userStore.js';
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

export class StdbPrimaryUserStore extends StdbStoreBase {
	private readonly stats = makeBaseStats();
	private readonly shadow = {
		attempted: 0,
		succeeded: 0,
		failed: 0,
		lastError: null as string | null,
		lastErrorAt: null as number | null
	};
	private readonly featureState: {
		userMeta: FeatureState;
		usernameLookup: FeatureState;
		handleLookup: FeatureState;
	} = {
		userMeta: 'unknown',
		usernameLookup: 'unknown',
		handleLookup: 'unknown'
	};

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
			return null;
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
				const detail = error instanceof Error ? error.message : String(error);
				console.warn(`[StatePlane] STDB user feature "${feature}" unavailable; falling back (${detail})`);
			}
			return null;
		}
	}

	private loadActiveUsers(limit = 50000): RegisteredUser[] {
		const rows = this.client.sqlRows(
			`SELECT row_json FROM state_user WHERE deleted = false LIMIT ${Math.max(1, Math.floor(limit))}`
		);
		return this.parseUsers(rows);
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
		// Preferred path: read the STDB-managed high-water mark.
		const metaRows = this.tryFeatureSqlRows(
			'userMeta',
			"SELECT next_user_id FROM state_user_meta WHERE meta_key = 'default' LIMIT 1"
		);
		if (metaRows && metaRows.length > 0) {
			const candidate = toNumber(metaRows[0].next_user_id);
			if (candidate > 0) return candidate;
		}

		// Fallback path for older modules without meta table support.
		const rows = this.client.sqlRows('SELECT user_id FROM state_user LIMIT 1000000');
		let currentMax = 0;
		for (const row of rows) {
			const value = toNumber(row.user_id);
			if (value > currentMax) currentMax = value;
		}
		return Math.max(1, currentMax + 1);
	}

	private findByUsernameScan(normalized: string): RegisteredUser | null {
		for (const user of this.loadActiveUsers()) {
			if ((user.username || '').trim().toLowerCase() === normalized) {
				return user;
			}
		}
		return null;
	}

	private findByHandleScan(normalized: string): RegisteredUser | null {
		for (const user of this.loadActiveUsers()) {
			if ((user.handle || '').replace(/^@/, '').toLowerCase() === normalized) {
				return user;
			}
		}
		return null;
	}

	private mirrorCreateUser(created: RegisteredUser): void {
		const exists = db.prepare('SELECT 1 FROM users WHERE user_id = ? LIMIT 1').get(created.user_id);
		if (exists) {
			db.prepare(`
				UPDATE users
				SET username = ?, handle = ?, password_hash = ?, created_at = ?, color = ?, profile_picture = ?, bio = ?,
					is_active = ?, username_font_family = ?, username_font_size = ?, username_font_weight = ?, username_font_style = ?
				WHERE user_id = ?
			`).run(
				created.username,
				created.handle || null,
				created.password_hash,
				created.created_at,
				created.color,
				created.profile_picture || null,
				created.bio || null,
				created.is_active ?? 1,
				created.username_font_family || null,
				created.username_font_size || null,
				created.username_font_weight || null,
				created.username_font_style || null,
				created.user_id
			);
			return;
		}

		db.prepare(`
			INSERT INTO users (
				user_id, username, handle, password_hash, created_at, color, profile_picture, bio, is_active,
				username_font_family, username_font_size, username_font_weight, username_font_style
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			created.user_id,
			created.username,
			created.handle || null,
			created.password_hash,
			created.created_at,
			created.color,
			created.profile_picture || null,
			created.bio || null,
			created.is_active ?? 1,
			created.username_font_family || null,
			created.username_font_size || null,
			created.username_font_weight || null,
			created.username_font_style || null
		);
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
				row: created
			});
			this.stats.writesSucceeded += 1;
		} catch (error) {
			this.recordWriteFailure(this.stats, 'create', error);
		}
		this.mirrorWrite(this.stats, this.shadow, 'create', () => {
			this.mirrorCreateUser(created);
		});
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

		return this.findByUsernameScan(normalized);
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

		return this.findByHandleScan(normalized);
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
				updates,
				row: next
			});
			this.stats.writesSucceeded += 1;
		} catch (error) {
			this.recordWriteFailure(this.stats, 'update', error);
		}
		this.mirrorWrite(this.stats, this.shadow, 'update', () => {
			userRepository.update(userId, updates);
		});
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
				row: next
			});
			this.stats.writesSucceeded += 1;
		} catch (error) {
			this.recordWriteFailure(this.stats, 'delete', error);
		}
		this.mirrorWrite(this.stats, this.shadow, 'delete', () => {
			userRepository.delete(userId);
		});
	}

	getAll(): RegisteredUser[] {
		bumpOperation(this.stats, 'getAll');
		const rows = this.client.sqlRows('SELECT row_json FROM state_user WHERE deleted = false AND active = true LIMIT 50000');
		return this.parseUsers(rows).sort((a, b) => (a.user_id || 0) - (b.user_id || 0));
	}

	warmFromPrimary(_limit: number): number {
		return 0;
	}

	getRuntimeStats(): UserStoreRuntimeStats {
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
