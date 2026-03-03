import {
	userRepository,
	type RegisteredUser
} from '../db/repositories/userRepository.js';
import db from '../db/database.js';
import type { UserStoreRuntimeStats } from './userStore.js';
import { escapeSqlLiteral } from './stdbSyncClient.js';
import {
	StdbStoreBase,
	bumpOperation,
	makeBaseStats,
	parseJsonObject,
	type StdbPrimaryStoreOptions,
	toNumber
} from './stdbCommon.js';

export class StdbPrimaryUserStore extends StdbStoreBase {
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

	private parseUsers(rows: Record<string, unknown>[]): RegisteredUser[] {
		const parsed: RegisteredUser[] = [];
		for (const row of rows) {
			const user = parseJsonObject<RegisteredUser>(row.row_json);
			if (!user) continue;
			parsed.push(user);
		}
		return parsed;
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
		const rows = this.client.sqlRows('SELECT MAX(user_id) AS max_user_id FROM state_user');
		const currentMax = rows.length > 0 ? toNumber(rows[0].max_user_id) : 0;
		return Math.max(1, currentMax + 1);
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
		const rows = this.client.sqlRows(
			`SELECT row_json FROM state_user WHERE username_lc = ${escapeSqlLiteral(username.toLowerCase())} AND deleted = false LIMIT 1`
		);
		if (rows.length === 0) return null;
		return parseJsonObject<RegisteredUser>(rows[0].row_json) || null;
	}

	findByHandle(handle: string): RegisteredUser | null {
		bumpOperation(this.stats, 'findByHandle');
		const normalized = handle.replace(/^@/, '').toLowerCase();
		if (!normalized) return null;
		const rows = this.client.sqlRows(
			`SELECT row_json FROM state_user WHERE handle_lc = ${escapeSqlLiteral(normalized)} AND deleted = false LIMIT 1`
		);
		if (rows.length === 0) return null;
		return parseJsonObject<RegisteredUser>(rows[0].row_json) || null;
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
