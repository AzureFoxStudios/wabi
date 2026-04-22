import db from '../db/database.js';
import type { RbacStoreRuntimeStats, RoleDefinitionRecord } from './storeTypes.js';
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

const DEFAULT_ROLE_DEFINITIONS: Array<{
	roleName: string;
	displayName: string;
	priority: number;
	color: string | null;
	isHoisted: boolean;
}> = [
	{ roleName: 'owner', displayName: 'Owner', priority: 100, color: '#FFD700', isHoisted: true },
	{ roleName: 'admin', displayName: 'Admin', priority: 90, color: '#FF4444', isHoisted: true },
	{ roleName: 'mod', displayName: 'Moderator', priority: 70, color: '#44FF44', isHoisted: true },
	{ roleName: 'member', displayName: 'Member', priority: 10, color: null, isHoisted: false },
	{ roleName: 'guest', displayName: 'Guest', priority: 0, color: '#888888', isHoisted: false }
];

export class StdbPrimaryRbacStore extends StdbStoreBase {
	private readonly stats = makeBaseStats();
	private readonly seededRoleDefinitionWorkspaces = new Set<string>();
	private static readonly FEATURE_RETRY_MS = 60_000;
	private roleDefinitionFeatureState: FeatureState = 'unknown';
	private roleDefinitionDisabledAt = 0;

	constructor(options: StdbPrimaryStoreOptions = {}) {
		super(options);
	}

	private queryRoleDefinitionsFromStdb(workspaceId: string): RoleDefinitionRecord[] | null {
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
				console.warn(`[StatePlane] STDB RBAC role definitions unavailable (${detail})`);
			}
			return null;
		}
	}

	private ensureRoleDefinitionsSeeded(workspaceId: string): boolean {
		if (this.seededRoleDefinitionWorkspaces.has(workspaceId)) {
			return this.roleDefinitionFeatureState !== 'disabled';
		}
		const existing = this.queryRoleDefinitionsFromStdb(workspaceId);
		if (existing === null) return false;
		if (existing.length > 0) {
			this.seededRoleDefinitionWorkspaces.add(workspaceId);
			return true;
		}

		for (const row of DEFAULT_ROLE_DEFINITIONS) {
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
		const stdbAvailable = this.ensureRoleDefinitionsSeeded(workspaceId);
		if (stdbAvailable) {
			const rows = this.queryRoleDefinitionsFromStdb(workspaceId);
			if (rows) return rows;
		}
		return DEFAULT_ROLE_DEFINITIONS.map((row) => ({
			workspaceId,
			roleName: row.roleName,
			displayName: row.displayName,
			priority: row.priority,
			color: row.color,
			isHoisted: row.isHoisted
		}));
	}

	getRolePriority(roleName: string, workspaceId: string): number {
		const row = this.getRoleDefinitions(workspaceId).find((entry) => entry.roleName === roleName);
		return row?.priority ?? 0;
	}

	roleExists(roleName: string, workspaceId: string): boolean {
		return this.getRoleDefinitions(workspaceId).some((entry) => entry.roleName === roleName);
	}

	countRoleAssignments(roleName: string, workspaceId: string): number {
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
	}

	workspaceHasOwner(workspaceId: string): boolean {
		const rows = this.client.sqlRows(
			`SELECT COUNT(*) AS count FROM state_rbac_assignment WHERE workspace_id = ${escapeSqlLiteral(workspaceId)} AND role = 'owner' AND active = true`
		);
		return rows.length > 0 && toNumber(rows[0].count) > 0;
	}

	getUserRoles(userId: number, workspaceId: string): string[] {
		const rows = this.client.sqlRows(
			`SELECT role FROM state_rbac_assignment WHERE user_id = ${Math.floor(userId)} AND workspace_id = ${escapeSqlLiteral(workspaceId)} AND active = true LIMIT 1000`
		);
		return rows
			.map((row) => String(row.role || '').trim())
			.filter((role) => role.length > 0)
			.sort((a, b) => a.localeCompare(b));
	}

	getWorkspaceRoleAssignments(workspaceId: string): Array<{ userId: number; role: string }> {
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
	}

	getRuntimeStats(): RbacStoreRuntimeStats {
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
