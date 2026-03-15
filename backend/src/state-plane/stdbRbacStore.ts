import db from '../db/database.js';
import type { RbacStoreRuntimeStats, RoleDefinitionRecord } from './rbacStore.js';
import { escapeSqlLiteral } from './stdbSyncClient.js';
import {
	StdbStoreBase,
	bumpOperation,
	makeBaseStats,
	type StdbPrimaryStoreOptions,
	toNumber
} from './stdbCommon.js';

type FeatureState = 'unknown' | 'enabled' | 'disabled';

function assignmentKey(workspaceId: string, userId: number, role: string): string {
	return `${workspaceId}:${userId}:${role}`;
}

function roleKey(workspaceId: string, roleName: string): string {
	return `${workspaceId}:${roleName}`;
}

export class StdbPrimaryRbacStore extends StdbStoreBase {
	private readonly stats = makeBaseStats();
	private readonly shadow = {
		attempted: 0,
		succeeded: 0,
		failed: 0,
		lastError: null as string | null,
		lastErrorAt: null as number | null
	};
	private readonly seededRoleDefinitionWorkspaces = new Set<string>();
	private static readonly FEATURE_RETRY_MS = 60_000;
	private roleDefinitionFeatureState: FeatureState = 'unknown';
	private roleDefinitionDisabledAt = 0;

	constructor(options: StdbPrimaryStoreOptions = {}) {
		super(options);
	}

	private loadLegacyRoleDefinitions(workspaceId: string): RoleDefinitionRecord[] {
		const legacyRows = db.prepare(`
			SELECT role_name, COALESCE(display_name, role_name) AS display_name, priority, color, is_hoisted
			FROM roles
			WHERE workspace_id = ?
			ORDER BY priority DESC, role_name ASC
		`).all(workspaceId) as Array<{
			role_name: string;
			display_name: string;
			priority: number;
			color: string | null;
			is_hoisted: number;
		}> || [];

		return legacyRows.map((row) => ({
			workspaceId,
			roleName: row.role_name,
			displayName: row.display_name,
			priority: Number(row.priority || 0),
			color: row.color || null,
			isHoisted: row.is_hoisted === 1
		}));
	}

	private queryRoleDefinitionsFromShadow(workspaceId: string): RoleDefinitionRecord[] | null {
		if (this.roleDefinitionFeatureState === 'disabled') {
			if (Date.now() - this.roleDefinitionDisabledAt < StdbPrimaryRbacStore.FEATURE_RETRY_MS) {
				return null;
			}
			this.roleDefinitionFeatureState = 'unknown';
		}

		try {
			const rows = this.client.sqlRows(
				`SELECT row_json
				 FROM state_role_definition
				 WHERE workspace_id = ${escapeSqlLiteral(workspaceId)} AND active = true
				 LIMIT 5000`
			);
			if (this.roleDefinitionFeatureState === 'unknown') {
				this.roleDefinitionFeatureState = 'enabled';
			}
			return rows
				.map((row) => {
					try {
						return JSON.parse(String(row.row_json || '')) as Record<string, unknown>;
					} catch {
						return null;
					}
				})
				.filter((row): row is Record<string, unknown> => row != null)
				.map((row) => ({
					workspaceId: String(row.workspace_id || workspaceId),
					roleName: String(row.role_name || '').trim(),
					displayName: String(row.display_name || row.role_name || '').trim(),
					priority: toNumber(row.priority),
					color: row.color == null ? null : String(row.color),
					isHoisted: toNumber(row.is_hoisted) !== 0
				}))
				.filter((row) => row.roleName.length > 0)
				.sort((a, b) => b.priority - a.priority || a.roleName.localeCompare(b.roleName));
		} catch (error) {
			if (this.roleDefinitionFeatureState !== 'disabled') {
				this.roleDefinitionFeatureState = 'disabled';
				this.roleDefinitionDisabledAt = Date.now();
				const detail = error instanceof Error ? error.message : String(error);
				console.warn(`[StatePlane] STDB RBAC role definitions unavailable; falling back (${detail})`);
			}
			return null;
		}
	}

	private ensureRoleDefinitionsSeeded(workspaceId: string): boolean {
		if (this.seededRoleDefinitionWorkspaces.has(workspaceId)) return this.roleDefinitionFeatureState !== 'disabled';
		const existing = this.queryRoleDefinitionsFromShadow(workspaceId);
		if (existing === null) {
			return false;
		}
		if (existing.length > 0) {
			this.seededRoleDefinitionWorkspaces.add(workspaceId);
			return true;
		}

		for (const row of this.loadLegacyRoleDefinitions(workspaceId)) {
			this.ingest('rbac', 'upsert_role_definition', {
				workspaceId,
				roleName: row.roleName,
				displayName: row.displayName,
				priority: row.priority,
				color: row.color,
				isHoisted: row.isHoisted,
				roleKey: roleKey(workspaceId, row.roleName),
				row: {
					role_name: row.roleName,
					workspace_id: workspaceId,
					display_name: row.displayName,
					priority: row.priority,
					color: row.color,
					is_hoisted: row.isHoisted ? 1 : 0
				}
			});
		}

		this.seededRoleDefinitionWorkspaces.add(workspaceId);
		return true;
	}

	getResourceMinRole(resourceId: string): string {
		const stmt = db.prepare(`
			SELECT min_role FROM resource_visibility
			WHERE resource_id = ?
		`);
		const result = stmt.get(resourceId) as { min_role?: string } | undefined;
		return result?.min_role || 'viewer';
	}

	getRoleDefinitions(workspaceId: string): RoleDefinitionRecord[] {
		const legacy = this.loadLegacyRoleDefinitions(workspaceId);
		if (legacy.length > 0) {
			return legacy;
		}

		const shadowAvailable = this.ensureRoleDefinitionsSeeded(workspaceId);
		if (shadowAvailable) {
			const rows = this.queryRoleDefinitionsFromShadow(workspaceId);
			if (rows) {
				return rows;
			}
		}
		return legacy;
	}

	getRolePriority(roleName: string, workspaceId: string): number {
		const row = this.getRoleDefinitions(workspaceId).find((entry) => entry.roleName === roleName);
		return row?.priority ?? 0;
	}

	roleExists(roleName: string, workspaceId: string): boolean {
		return this.getRoleDefinitions(workspaceId).some((entry) => entry.roleName === roleName);
	}

	countRoleAssignments(roleName: string, workspaceId: string): number {
		const mirrored = db.prepare(`
			SELECT COUNT(*) AS count
			FROM user_roles
			WHERE workspace_id = ? AND role_name = ?
		`).get(workspaceId, roleName) as { count?: number } | undefined;
		if (mirrored && typeof mirrored.count === 'number') {
			return toNumber(mirrored.count);
		}

		const rows = this.client.sqlRows(
			`SELECT COUNT(*) AS count FROM state_rbac_assignment WHERE workspace_id = ${escapeSqlLiteral(workspaceId)} AND role = ${escapeSqlLiteral(roleName)} AND active = true`
		);
		return rows.length > 0 ? toNumber(rows[0].count) : 0;
	}

	setRoleDisplayName(roleName: string, displayName: string, workspaceId: string): void {
		const nextDisplay = (displayName || '').trim();
		if (nextDisplay.length < 1 || nextDisplay.length > 40) {
			throw new Error('Role display names must be 1-40 characters');
		}

		this.ensureRoleDefinitionsSeeded(workspaceId);
		const current = this.getRoleDefinitions(workspaceId).find((entry) => entry.roleName === roleName);
		if (!current) {
			throw new Error(`Unknown role: ${roleName}`);
		}

		bumpOperation(this.stats, 'set_role_display_name');
		this.stats.writesAttempted += 1;
		try {
			this.ingest('rbac', 'upsert_role_definition', {
				workspaceId,
				roleName,
				displayName: nextDisplay,
				priority: current.priority,
				color: current.color,
				isHoisted: current.isHoisted,
				roleKey: roleKey(workspaceId, roleName),
				row: {
					role_name: roleName,
					workspace_id: workspaceId,
					display_name: nextDisplay,
					priority: current.priority,
					color: current.color,
					is_hoisted: current.isHoisted ? 1 : 0
				}
			});
			this.stats.writesSucceeded += 1;
		} catch (error) {
			this.recordWriteFailure(this.stats, 'set_role_display_name', error);
		}
		this.mirrorWrite(this.stats, this.shadow, 'set_role_display_name', () => {
			db.prepare(`
				UPDATE roles
				SET display_name = ?
				WHERE role_name = ? AND workspace_id = ?
			`).run(nextDisplay, roleName, workspaceId);
		});
	}

	workspaceHasOwner(workspaceId: string): boolean {
		const mirrored = db.prepare(`
			SELECT 1
			FROM user_roles
			WHERE workspace_id = ? AND role_name = 'owner'
			LIMIT 1
		`).get(workspaceId);
		if (mirrored) {
			return true;
		}

		const rows = this.client.sqlRows(
			`SELECT COUNT(*) AS count FROM state_rbac_assignment WHERE workspace_id = ${escapeSqlLiteral(workspaceId)} AND role = 'owner' AND active = true`
		);
		return rows.length > 0 && toNumber(rows[0].count) > 0;
	}

	getUserRoles(userId: number, workspaceId: string): string[] {
		const mirrored = db.prepare(`
			SELECT role_name
			FROM user_roles
			WHERE user_id = ? AND workspace_id = ?
			ORDER BY role_name ASC
		`).all(userId, workspaceId) as Array<{ role_name?: string }>;
		if (mirrored.length > 0) {
			return mirrored
				.map((row) => String(row.role_name || '').trim())
				.filter((role) => role.length > 0);
		}

		const rows = this.client.sqlRows(
			`SELECT role FROM state_rbac_assignment WHERE user_id = ${Math.floor(userId)} AND workspace_id = ${escapeSqlLiteral(workspaceId)} AND active = true LIMIT 1000`
		);
		return rows
			.map((row) => String(row.role || '').trim())
			.filter((role) => role.length > 0)
			.sort((a, b) => a.localeCompare(b));
	}

	getWorkspaceRoleAssignments(workspaceId: string): Array<{ userId: number; role: string }> {
		const mirrored = db.prepare(`
			SELECT user_id, role_name
			FROM user_roles
			WHERE workspace_id = ?
			ORDER BY user_id ASC, role_name ASC
		`).all(workspaceId) as Array<{ user_id?: number; role_name?: string }>;
		if (mirrored.length > 0) {
			return mirrored
				.map((row) => ({
					userId: toNumber(row.user_id),
					role: String(row.role_name || '').trim()
				}))
				.filter((row) => Number.isFinite(row.userId) && row.userId > 0 && row.role.length > 0);
		}

		const rows = this.client.sqlRows(
			`SELECT user_id, role FROM state_rbac_assignment WHERE workspace_id = ${escapeSqlLiteral(workspaceId)} AND active = true LIMIT 50000`
		);
		return rows
			.map((row) => ({
				userId: toNumber(row.user_id),
				role: String(row.role || '').trim()
			}))
			.filter((row) => Number.isFinite(row.userId) && row.userId > 0 && row.role.length > 0)
			.sort((a, b) => a.userId - b.userId || a.role.localeCompare(b.role));
	}

	assignRole(userId: number, role: string, workspaceId: string, assignedBy?: number): void {
		bumpOperation(this.stats, 'assign_role');
		this.stats.writesAttempted += 1;
		try {
			this.ingest('rbac', 'assign_role', {
				userId,
				role,
				workspaceId,
				assignedBy: assignedBy ?? null,
				assignmentKey: assignmentKey(workspaceId, userId, role)
			});
			this.stats.writesSucceeded += 1;
		} catch (error) {
			this.recordWriteFailure(this.stats, 'assign_role', error);
		}
		this.mirrorWrite(this.stats, this.shadow, 'assign_role', () => {
			const stmt = db.prepare(`
				INSERT INTO user_roles (user_id, role_name, workspace_id)
				SELECT ?, ?, ?
				WHERE NOT EXISTS (
					SELECT 1 FROM user_roles WHERE user_id = ? AND role_name = ? AND workspace_id = ?
				)
			`);
			stmt.run(userId, role, workspaceId, userId, role, workspaceId);
		});
	}

	removeRole(userId: number, role: string, workspaceId: string): void {
		bumpOperation(this.stats, 'remove_role');
		this.stats.writesAttempted += 1;
		try {
			this.ingest('rbac', 'remove_role', {
				userId,
				role,
				workspaceId,
				assignmentKey: assignmentKey(workspaceId, userId, role)
			});
			this.stats.writesSucceeded += 1;
		} catch (error) {
			this.recordWriteFailure(this.stats, 'remove_role', error);
		}
		this.mirrorWrite(this.stats, this.shadow, 'remove_role', () => {
			const stmt = db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_name = ? AND workspace_id = ?');
			stmt.run(userId, role, workspaceId);
		});
	}

	warmFromPrimary(limit: number): number {
		const safeLimit = Math.max(0, Math.floor(limit));
		if (safeLimit === 0) return 0;
		const existingAssignments = new Set(
			this.client.sqlRows('SELECT user_id, workspace_id, role FROM state_rbac_assignment LIMIT 50000')
				.map((row) => ({
					workspaceId: String(row.workspace_id || '').trim(),
					userId: toNumber(row.user_id),
					role: String(row.role || '').trim()
				}))
				.filter((row) => row.workspaceId.length > 0 && row.userId > 0 && row.role.length > 0)
				.map((row) => assignmentKey(row.workspaceId, row.userId, row.role))
		);

		const rows = db.prepare(`
			SELECT user_id, workspace_id, role_name
			FROM user_roles
			ORDER BY workspace_id ASC, user_id ASC, created_at ASC
			LIMIT ?
		`).all(safeLimit) as Array<{ user_id: number; workspace_id: string; role_name: string }>;

		let seeded = 0;
		for (const row of rows) {
			const key = assignmentKey(row.workspace_id, row.user_id, row.role_name);
			if (existingAssignments.has(key)) continue;
			this.ingest('rbac', 'assign_role', {
				userId: row.user_id,
				role: row.role_name,
				workspaceId: row.workspace_id,
				assignedBy: null,
				assignmentKey: key
			});
			seeded += 1;
		}

		this.stats.operations.warmup = (this.stats.operations.warmup || 0) + 1;
		this.stats.operations.warmup_rows = seeded;
		return seeded;
	}

	getRuntimeStats(): RbacStoreRuntimeStats {
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
