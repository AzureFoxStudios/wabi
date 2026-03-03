import {
	userRepository,
	type RegisteredUser
} from '../db/repositories/userRepository.js';
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

export interface UserStoreRuntimeStats {
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

export interface StateUserStoreOptions {
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

function normalizeHandle(handle: string | undefined): string {
	return (handle || '').replace(/^@/, '').toLowerCase();
}

function normalizeUsername(username: string): string {
	return username.toLowerCase();
}

function compareUsers(a: RegisteredUser | null, b: RegisteredUser | null): string | null {
	if (!a && !b) return null;
	if (!a || !b) return `presence_mismatch primary=${Boolean(a)} shadow=${Boolean(b)}`;

	if ((a.user_id || 0) !== (b.user_id || 0)) return 'user_id_mismatch';
	if (a.username !== b.username) return 'username_mismatch';
	if (normalizeHandle(a.handle) !== normalizeHandle(b.handle)) return 'handle_mismatch';
	if (a.color !== b.color) return 'color_mismatch';
	if ((a.profile_picture || null) !== (b.profile_picture || null)) return 'profile_picture_mismatch';
	if ((a.bio || null) !== (b.bio || null)) return 'bio_mismatch';
	if ((a.is_active ?? 1) !== (b.is_active ?? 1)) return 'is_active_mismatch';
	if ((a.username_font_family || null) !== (b.username_font_family || null)) return 'username_font_family_mismatch';
	if ((a.username_font_size || null) !== (b.username_font_size || null)) return 'username_font_size_mismatch';
	if ((a.username_font_weight || null) !== (b.username_font_weight || null)) return 'username_font_weight_mismatch';
	if ((a.username_font_style || null) !== (b.username_font_style || null)) return 'username_font_style_mismatch';

	return null;
}

export class StateUserStore {
	private readonly dualWriteEnabled: boolean;
	private readonly paritySampleRate: number;
	private readonly label: string;
	private readonly strictShadow: boolean;
	private readonly readShadowEnabled: boolean;
	private readonly readCanaryPercent: number;
	private shadowUsers = new Map<number, RegisteredUser>();
	private usernameIndex = new Map<string, number>();
	private handleIndex = new Map<string, number>();
	private stats: UserStoreRuntimeStats = {
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
		options: StateUserStoreOptions = {}
	) {
		this.dualWriteEnabled = options.dualWriteEnabled === true;
		this.label = options.label || 'user-shadow';
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

	private cloneUser(user: RegisteredUser): RegisteredUser {
		return { ...user };
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
				console.warn(`[StatePlane] User shadow operation failed (${op}); continuing with primary store`, error);
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
			console.warn(`[StatePlane] User shadow read failed (${op}); falling back to primary`, error);
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

	private upsertShadowUser(user: RegisteredUser): void {
		if (!user.user_id) return;
		const next = this.cloneUser(user);
		const existing = this.shadowUsers.get(user.user_id);
		if (existing) {
			this.usernameIndex.delete(normalizeUsername(existing.username));
			const oldHandle = normalizeHandle(existing.handle);
			if (oldHandle) this.handleIndex.delete(oldHandle);
		}

		this.shadowUsers.set(user.user_id, next);
		this.usernameIndex.set(normalizeUsername(next.username), user.user_id);
		const handle = normalizeHandle(next.handle);
		if (handle) this.handleIndex.set(handle, user.user_id);
	}

	private removeShadowUser(userId: number): void {
		const existing = this.shadowUsers.get(userId);
		if (!existing) return;
		this.usernameIndex.delete(normalizeUsername(existing.username));
		const handle = normalizeHandle(existing.handle);
		if (handle) this.handleIndex.delete(handle);
		this.shadowUsers.delete(userId);
	}

	private hydrateShadowFromPrimary(userId: number): void {
		const primary = userRepository.findById(userId);
		if (!primary) {
			this.removeShadowUser(userId);
			return;
		}
		this.upsertShadowUser(primary);
	}

	private appendOutbox(operation: string, payload: Record<string, unknown>): void {
		this.outbox?.append({
			timestamp: Date.now(),
			entity: 'user',
			operation,
			payload
		});
	}

	create(user: Omit<RegisteredUser, 'user_id'>): RegisteredUser {
		try {
			const created = userRepository.create(user);
			this.trackPrimarySuccess('create');
			this.shadowBestEffort('create', () => {
				this.upsertShadowUser(created);
			});
			this.appendOutbox('create', {
				userId: created.user_id || null,
				username: created.username,
				handle: created.handle || null
			});
			return created;
		} catch (error) {
			this.trackPrimaryFailure('create', error);
			throw error;
		}
	}

	findByUsername(username: string): RegisteredUser | null {
		this.recordReadAttempt();
		const primary = userRepository.findByUsername(username);
		if (this.shouldRunReadCanary()) {
			this.recordReadCanaryRoute();
			this.recordParitySample();
			try {
				const shadowUserId = this.usernameIndex.get(normalizeUsername(username));
				const shadow = shadowUserId ? this.shadowUsers.get(shadowUserId) || null : null;
				if (!shadow && primary) {
					this.upsertShadowUser(primary);
					this.recordReadFallback('cold:findByUsername');
					return primary;
				}
				const mismatch = compareUsers(primary, shadow || null);
				if (mismatch) {
					this.recordParityMismatch(`read_canary:findByUsername(${username}): ${mismatch}`);
					this.stats.readSwitch.mismatches += 1;
					this.recordReadFallback('mismatch:findByUsername');
					return primary;
				}
				if (shadow) {
					this.recordReadServedByShadow();
					return this.cloneUser(shadow);
				}
				return shadow;
			} catch (error) {
				this.recordReadShadowError('findByUsername', error);
				return primary;
			}
		}
		if (!this.shouldRunParitySample()) return primary;

		this.recordParitySample();
		const shadowUserId = this.usernameIndex.get(normalizeUsername(username));
		const shadow = shadowUserId ? this.shadowUsers.get(shadowUserId) || null : null;
		if (!shadow && primary) {
			this.upsertShadowUser(primary);
			return primary;
		}
		const mismatch = compareUsers(primary, shadow || null);
		if (mismatch) {
			this.recordParityMismatch(`findByUsername(${username}): ${mismatch}`);
		}
		return primary;
	}

	findByHandle(handle: string): RegisteredUser | null {
		this.recordReadAttempt();
		const primary = userRepository.findByHandle(handle);
		if (this.shouldRunReadCanary()) {
			this.recordReadCanaryRoute();
			this.recordParitySample();
			try {
				const shadowHandle = normalizeHandle(handle);
				const shadowUserId = shadowHandle ? this.handleIndex.get(shadowHandle) : undefined;
				const shadow = shadowUserId ? this.shadowUsers.get(shadowUserId) || null : null;
				if (!shadow && primary) {
					this.upsertShadowUser(primary);
					this.recordReadFallback('cold:findByHandle');
					return primary;
				}
				const mismatch = compareUsers(primary, shadow || null);
				if (mismatch) {
					this.recordParityMismatch(`read_canary:findByHandle(${handle}): ${mismatch}`);
					this.stats.readSwitch.mismatches += 1;
					this.recordReadFallback('mismatch:findByHandle');
					return primary;
				}
				if (shadow) {
					this.recordReadServedByShadow();
					return this.cloneUser(shadow);
				}
				return shadow;
			} catch (error) {
				this.recordReadShadowError('findByHandle', error);
				return primary;
			}
		}
		if (!this.shouldRunParitySample()) return primary;

		this.recordParitySample();
		const shadowHandle = normalizeHandle(handle);
		const shadowUserId = shadowHandle ? this.handleIndex.get(shadowHandle) : undefined;
		const shadow = shadowUserId ? this.shadowUsers.get(shadowUserId) || null : null;
		if (!shadow && primary) {
			this.upsertShadowUser(primary);
			return primary;
		}
		const mismatch = compareUsers(primary, shadow || null);
		if (mismatch) {
			this.recordParityMismatch(`findByHandle(${handle}): ${mismatch}`);
		}
		return primary;
	}

	findByHandleOrUsername(identifier: string): RegisteredUser | null {
		const byHandle = this.findByHandle(identifier);
		if (byHandle) return byHandle;
		return this.findByUsername(identifier);
	}

	findById(userId: number): RegisteredUser | null {
		this.recordReadAttempt();
		const primary = userRepository.findById(userId);
		if (this.shouldRunReadCanary()) {
			this.recordReadCanaryRoute();
			this.recordParitySample();
			try {
				const shadow = this.shadowUsers.get(userId) || null;
				if (!shadow && primary) {
					this.upsertShadowUser(primary);
					this.recordReadFallback('cold:findById');
					return primary;
				}
				const mismatch = compareUsers(primary, shadow || null);
				if (mismatch) {
					this.recordParityMismatch(`read_canary:findById(${userId}): ${mismatch}`);
					this.stats.readSwitch.mismatches += 1;
					this.recordReadFallback('mismatch:findById');
					return primary;
				}
				if (shadow) {
					this.recordReadServedByShadow();
					return this.cloneUser(shadow);
				}
				return shadow;
			} catch (error) {
				this.recordReadShadowError('findById', error);
				return primary;
			}
		}
		if (!this.shouldRunParitySample()) return primary;

		this.recordParitySample();
		const shadow = this.shadowUsers.get(userId) || null;
		if (!shadow && primary) {
			this.upsertShadowUser(primary);
			return primary;
		}
		const mismatch = compareUsers(primary, shadow || null);
		if (mismatch) {
			this.recordParityMismatch(`findById(${userId}): ${mismatch}`);
		}
		return primary;
	}

	update(userId: number, updates: Partial<RegisteredUser>): void {
		try {
			userRepository.update(userId, updates);
			this.trackPrimarySuccess('update');
			this.shadowBestEffort('update', () => {
				this.hydrateShadowFromPrimary(userId);
			});
			this.appendOutbox('update', {
				userId,
				updatedFields: Object.keys(updates)
			});
		} catch (error) {
			this.trackPrimaryFailure('update', error);
			throw error;
		}
	}

	delete(userId: number): void {
		try {
			userRepository.delete(userId);
			this.trackPrimarySuccess('delete');
			this.shadowBestEffort('delete', () => {
				this.removeShadowUser(userId);
			});
			this.appendOutbox('delete', { userId });
		} catch (error) {
			this.trackPrimaryFailure('delete', error);
			throw error;
		}
	}

	getAll(): RegisteredUser[] {
		this.recordReadAttempt();
		const primary = userRepository.getAll();
		if (this.shouldRunReadCanary()) {
			this.recordReadCanaryRoute();
			this.recordParitySample();
			try {
				const shadowRows = Array.from(this.shadowUsers.values())
					.filter((user) => (user.is_active ?? 1) === 1)
					.sort((a, b) => (a.user_id || 0) - (b.user_id || 0));

				if (shadowRows.length === 0 && primary.length > 0) {
					for (const row of primary) {
						this.upsertShadowUser(row);
					}
					this.recordReadFallback('cold:getAll');
					return primary;
				}

				const orderedPrimary = [...primary].sort((a, b) => (a.user_id || 0) - (b.user_id || 0));
				if (orderedPrimary.length !== shadowRows.length) {
					this.recordParityMismatch(`read_canary:getAll: row_count_mismatch primary=${orderedPrimary.length} shadow=${shadowRows.length}`);
					this.stats.readSwitch.mismatches += 1;
					this.recordReadFallback('mismatch:getAll');
					return primary;
				}

				for (let i = 0; i < orderedPrimary.length; i += 1) {
					const mismatch = compareUsers(orderedPrimary[i], shadowRows[i]);
					if (mismatch) {
						this.recordParityMismatch(`read_canary:getAll index=${i}: ${mismatch}`);
						this.stats.readSwitch.mismatches += 1;
						this.recordReadFallback('mismatch:getAll');
						return primary;
					}
				}

				this.recordReadServedByShadow();
				return shadowRows.map((user) => this.cloneUser(user));
			} catch (error) {
				this.recordReadShadowError('getAll', error);
				return primary;
			}
		}
		if (!this.shouldRunParitySample()) return primary;

		this.recordParitySample();
		const shadowRows = Array.from(this.shadowUsers.values())
			.filter((user) => (user.is_active ?? 1) === 1)
			.sort((a, b) => (a.user_id || 0) - (b.user_id || 0));

		if (shadowRows.length === 0 && primary.length > 0) {
			for (const row of primary) {
				this.upsertShadowUser(row);
			}
			return primary;
		}

		const orderedPrimary = [...primary].sort((a, b) => (a.user_id || 0) - (b.user_id || 0));
		if (orderedPrimary.length !== shadowRows.length) {
			this.recordParityMismatch(`getAll: row_count_mismatch primary=${orderedPrimary.length} shadow=${shadowRows.length}`);
			return primary;
		}

		for (let i = 0; i < orderedPrimary.length; i += 1) {
			const mismatch = compareUsers(orderedPrimary[i], shadowRows[i]);
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
			SELECT * FROM users
			ORDER BY user_id ASC
			LIMIT ?
		`).all(safeLimit) as RegisteredUser[];

		this.shadowBestEffort('warmup', () => {
			this.shadowUsers.clear();
			this.usernameIndex.clear();
			this.handleIndex.clear();
			for (const row of rows) {
				this.upsertShadowUser(row);
			}
		});

		this.stats.operations.warmup = (this.stats.operations.warmup || 0) + 1;
		this.stats.operations.warmup_rows = rows.length;
		return rows.length;
	}

	getRuntimeStats(): UserStoreRuntimeStats {
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
