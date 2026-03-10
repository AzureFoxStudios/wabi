import db from '../db/database.js';
import type { RbacStoreRuntimeStats } from './rbacStore.js';
import { escapeSqlLiteral } from './stdbSyncClient.js';
import {
	StdbStoreBase,
	bumpOperation,
	makeBaseStats,
	type StdbPrimaryStoreOptions,
	toNumber
} from './stdbCommon.js';

function assignmentKey(workspaceId: string, userId: number, role: string): string {
	return `${workspaceId}:${userId}:${role}`;
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

	constructor(options: StdbPrimaryStoreOptions = {}) {
		super(options);
	}

	getResourceMinRole(resourceId: string): string {
		const stmt = db.prepare(`
			SELECT min_role FROM resource_visibility
			WHERE resource_id = ?
		`);
		const result = stmt.get(resourceId) as { min_role?: string } | undefined;
		return result?.min_role || 'viewer';
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

	warmFromPrimary(_limit: number): number {
		return 0;
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
