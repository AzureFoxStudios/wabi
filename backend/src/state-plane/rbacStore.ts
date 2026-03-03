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

export interface RbacStoreRuntimeStats {
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

export interface StateRbacStoreOptions {
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

function assignmentKey(userId: number, workspaceId: string): string {
	return `${workspaceId}:${userId}`;
}

function sortRoles(roles: string[]): string[] {
	return [...roles].sort((a, b) => a.localeCompare(b));
}

export class StateRbacStore {
	private readonly dualWriteEnabled: boolean;
	private readonly paritySampleRate: number;
	private readonly label: string;
	private readonly strictShadow: boolean;
	private readonly readShadowEnabled: boolean;
	private readonly readCanaryPercent: number;
	private shadowAssignments = new Map<string, Set<string>>();
	private seededKeys = new Set<string>();
	private stats: RbacStoreRuntimeStats = {
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
		options: StateRbacStoreOptions = {}
	) {
		this.dualWriteEnabled = options.dualWriteEnabled === true;
		this.label = options.label || 'rbac-shadow';
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

	private queryRoles(userId: number, workspaceId: string): string[] {
		const stmt = db.prepare(`
			SELECT role_name FROM user_roles
			WHERE user_id = ? AND workspace_id = ?
			ORDER BY created_at ASC
		`);
		const rows = stmt.all(userId, workspaceId) as { role_name: string }[] || [];
		return rows.map((row) => row.role_name);
	}

	getResourceMinRole(resourceId: string): string {
		const stmt = db.prepare(`
			SELECT min_role FROM resource_visibility
			WHERE resource_id = ?
		`);
		const result = stmt.get(resourceId) as { min_role: string } | undefined;
		return result?.min_role || 'viewer';
	}

	workspaceHasOwner(workspaceId: string): boolean {
		this.recordReadAttempt();
		const ownerExists = db.prepare(
			"SELECT 1 FROM user_roles WHERE role_name = 'owner' AND workspace_id = ? LIMIT 1"
		).get(workspaceId);
		const primary = Boolean(ownerExists);
		if (this.shouldRunReadCanary()) {
			this.recordReadCanaryRoute();
			this.recordParitySample();
			try {
				let shadowHasOwner = false;
				let hasSeedForWorkspace = false;
				const prefix = `${workspaceId}:`;
				for (const key of this.seededKeys) {
					if (!key.startsWith(prefix)) continue;
					hasSeedForWorkspace = true;
					const roles = this.shadowAssignments.get(key);
					if (roles?.has('owner')) {
						shadowHasOwner = true;
						break;
					}
				}
				if (!hasSeedForWorkspace) {
					this.recordReadFallback('cold:workspaceHasOwner');
					return primary;
				}
				if (primary !== shadowHasOwner) {
					this.recordParityMismatch(
						`read_canary:workspaceHasOwner(${workspaceId}): bool_mismatch primary=${primary} shadow=${shadowHasOwner}`
					);
					this.stats.readSwitch.mismatches += 1;
					this.recordReadFallback('mismatch:workspaceHasOwner');
					return primary;
				}
				this.recordReadServedByShadow();
				return shadowHasOwner;
			} catch (error) {
				this.recordReadShadowError('workspaceHasOwner', error);
				return primary;
			}
		}
		if (!this.shouldRunParitySample()) return primary;

		this.recordParitySample();
		let shadowHasOwner = false;
		let hasSeedForWorkspace = false;
		const prefix = `${workspaceId}:`;
		for (const key of this.seededKeys) {
			if (!key.startsWith(prefix)) continue;
			hasSeedForWorkspace = true;
			const roles = this.shadowAssignments.get(key);
			if (roles?.has('owner')) {
				shadowHasOwner = true;
				break;
			}
		}
		if (!hasSeedForWorkspace) return primary;
		if (primary !== shadowHasOwner) {
			this.recordParityMismatch(
				`workspaceHasOwner(${workspaceId}): bool_mismatch primary=${primary} shadow=${shadowHasOwner}`
			);
		}
		return primary;
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
				console.warn(`[StatePlane] RBAC shadow operation failed (${op}); continuing with primary store`, error);
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
			console.warn(`[StatePlane] RBAC shadow read failed (${op}); falling back to primary`, error);
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
			entity: 'rbac',
			operation,
			payload
		});
	}

	private ensureSeeded(userId: number, workspaceId: string): void {
		const key = assignmentKey(userId, workspaceId);
		if (this.seededKeys.has(key)) return;
		const roles = this.queryRoles(userId, workspaceId);
		this.shadowAssignments.set(key, new Set(roles));
		this.seededKeys.add(key);
	}

	getUserRoles(userId: number, workspaceId: string): string[] {
		this.recordReadAttempt();
		const primary = this.queryRoles(userId, workspaceId);
		if (this.shouldRunReadCanary()) {
			this.recordReadCanaryRoute();
			this.recordParitySample();
			try {
				this.ensureSeeded(userId, workspaceId);
				const key = assignmentKey(userId, workspaceId);
				const shadow = sortRoles(Array.from(this.shadowAssignments.get(key) || []));
				const orderedPrimary = sortRoles(primary);
				if (orderedPrimary.length !== shadow.length) {
					this.recordParityMismatch(
						`read_canary:getUserRoles(${workspaceId}:${userId}): row_count_mismatch primary=${orderedPrimary.length} shadow=${shadow.length}`
					);
					this.stats.readSwitch.mismatches += 1;
					this.recordReadFallback('mismatch:getUserRoles');
					return primary;
				}
				for (let i = 0; i < orderedPrimary.length; i += 1) {
					if (orderedPrimary[i] !== shadow[i]) {
						this.recordParityMismatch(
							`read_canary:getUserRoles(${workspaceId}:${userId}): role_mismatch index=${i} primary=${orderedPrimary[i]} shadow=${shadow[i]}`
						);
						this.stats.readSwitch.mismatches += 1;
						this.recordReadFallback('mismatch:getUserRoles');
						return primary;
					}
				}
				this.recordReadServedByShadow();
				return shadow;
			} catch (error) {
				this.recordReadShadowError('getUserRoles', error);
				return primary;
			}
		}
		if (!this.shouldRunParitySample()) return primary;

		this.recordParitySample();
		this.ensureSeeded(userId, workspaceId);
		const key = assignmentKey(userId, workspaceId);
		const shadow = sortRoles(Array.from(this.shadowAssignments.get(key) || []));
		const orderedPrimary = sortRoles(primary);

		if (orderedPrimary.length !== shadow.length) {
			this.recordParityMismatch(
				`getUserRoles(${workspaceId}:${userId}): row_count_mismatch primary=${orderedPrimary.length} shadow=${shadow.length}`
			);
			return primary;
		}
		for (let i = 0; i < orderedPrimary.length; i += 1) {
			if (orderedPrimary[i] !== shadow[i]) {
				this.recordParityMismatch(
					`getUserRoles(${workspaceId}:${userId}): role_mismatch index=${i} primary=${orderedPrimary[i]} shadow=${shadow[i]}`
				);
				break;
			}
		}
		return primary;
	}

	assignRole(userId: number, role: string, workspaceId: string, assignedBy?: number): void {
		try {
			const stmt = db.prepare(`
				INSERT INTO user_roles (user_id, role_name, workspace_id)
				SELECT ?, ?, ?
				WHERE NOT EXISTS (
					SELECT 1 FROM user_roles
					WHERE user_id = ? AND role_name = ? AND workspace_id = ?
				)
			`);
			stmt.run(userId, role, workspaceId, userId, role, workspaceId);

			this.trackPrimarySuccess('assign_role');
			this.shadowBestEffort('assign_role', () => {
				this.ensureSeeded(userId, workspaceId);
				const key = assignmentKey(userId, workspaceId);
				const roles = this.shadowAssignments.get(key) || new Set<string>();
				roles.add(role);
				this.shadowAssignments.set(key, roles);
			});
			this.appendOutbox('assign_role', {
				userId,
				role,
				workspaceId,
				assignedBy: assignedBy ?? null
			});
		} catch (error) {
			this.trackPrimaryFailure('assign_role', error);
			throw error;
		}
	}

	removeRole(userId: number, role: string, workspaceId: string): void {
		try {
			const stmt = db.prepare(`
				DELETE FROM user_roles
				WHERE user_id = ? AND role_name = ? AND workspace_id = ?
			`);
			stmt.run(userId, role, workspaceId);

			this.trackPrimarySuccess('remove_role');
			this.shadowBestEffort('remove_role', () => {
				this.ensureSeeded(userId, workspaceId);
				const key = assignmentKey(userId, workspaceId);
				const roles = this.shadowAssignments.get(key);
				if (!roles) return;
				roles.delete(role);
				this.shadowAssignments.set(key, roles);
			});
			this.appendOutbox('remove_role', {
				userId,
				role,
				workspaceId
			});
		} catch (error) {
			this.trackPrimaryFailure('remove_role', error);
			throw error;
		}
	}

	warmFromPrimary(limit: number): number {
		if (!this.dualWriteEnabled) return 0;
		const safeLimit = Math.max(0, Math.floor(limit));
		if (safeLimit === 0) return 0;

		const rows = db.prepare(`
			SELECT user_id, workspace_id, role_name
			FROM user_roles
			ORDER BY workspace_id ASC, user_id ASC, created_at ASC
			LIMIT ?
		`).all(safeLimit) as Array<{ user_id: number; workspace_id: string; role_name: string }>;

		this.shadowBestEffort('warmup', () => {
			this.shadowAssignments.clear();
			this.seededKeys.clear();
			for (const row of rows) {
				const key = assignmentKey(row.user_id, row.workspace_id);
				let roles = this.shadowAssignments.get(key);
				if (!roles) {
					roles = new Set<string>();
					this.shadowAssignments.set(key, roles);
				}
				roles.add(row.role_name);
				this.seededKeys.add(key);
			}
		});

		this.stats.operations.warmup = (this.stats.operations.warmup || 0) + 1;
		this.stats.operations.warmup_rows = rows.length;
		return rows.length;
	}

	getRuntimeStats(): RbacStoreRuntimeStats {
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
