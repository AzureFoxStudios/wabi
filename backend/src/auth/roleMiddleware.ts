import db from '../db/database.js';
import { userRepository } from '../db/repositories/userRepository.js';

export type UserRole = 'admin' | 'mod' | 'contributor' | 'viewer' | 'owner';

export interface UserWithRoles {
	user_id?: number;
	username: string;
	color: string;
	profile_picture?: string;
	roles?: UserRole[];
	workspaceId?: string;
}

/**
 * Get all roles for a user in a workspace
 */
export function getUserRoles(userId: number, workspaceId: string = 'default-workspace'): UserRole[] {
	const user = userRepository.findById(userId);
	if (!user) return [];

	// For now, return default roles based on creation time
	// Later: Query user_roles table
	const stmt = db.prepare(`
		SELECT role_name FROM user_roles
		WHERE user_id = ? AND workspace_id = ?
		ORDER BY created_at ASC
	`);

	const result = stmt.all(userId, workspaceId) as { role_name: string }[] || [];
	return result.map(r => r.role_name as UserRole);
}

/**
 * Check if user has at least one of the required roles
 */
export function hasRequiredRole(
	userId: number | undefined,
	requiredRoles: UserRole[],
	workspaceId: string = 'default-workspace'
): boolean {
	if (!userId) return false;

	const userRoles = getUserRoles(userId, workspaceId);

	// Admin has all permissions
	if (userRoles.includes('admin') || userRoles.includes('owner')) {
		return true;
	}

	// Check if user has any of the required roles
	return userRoles.some(role => requiredRoles.includes(role));
}

/**
 * Get minimum role for a resource
 */
export function getResourceMinRole(resourceId: string): UserRole {
	const stmt = db.prepare(`
		SELECT min_role FROM resource_visibility
		WHERE resource_id = ?
	`);

	const result = stmt.get(resourceId) as { min_role: string } | undefined;
	return result?.min_role as UserRole || 'viewer';
}

/**
 * Check if user can view a resource
 */
export function canViewResource(
	userId: number | undefined,
	resourceId: string,
	workspaceId: string = 'default-workspace'
): boolean {
	if (!userId) return false;

	// Get minimum required role
	const minRole = getResourceMinRole(resourceId);

	// Get user's roles
	const userRoles = getUserRoles(userId, workspaceId);

	// Admin/owner can view everything
	if (userRoles.includes('admin') || userRoles.includes('owner')) {
		return true;
	}

	// Check if user meets minimum role requirement
	const roleHierarchy: Record<UserRole, number> = {
		'admin': 100,
		'owner': 100,
		'mod': 80,
		'contributor': 60,
		'viewer': 40
	};

	const userLevel = Math.max(...userRoles.map(r => roleHierarchy[r] || 0));
	const requiredLevel = roleHierarchy[minRole] || 40;

	return userLevel >= requiredLevel;
}

/**
 * Filter resources by user role
 */
export function filterResourcesByRole<T extends { id: string }>(
	resources: T[],
	userId: number | undefined,
	workspaceId: string = 'default-workspace'
): T[] {
	if (!userId) return resources;

	return resources.filter(resource =>
		canViewResource(userId, resource.id, workspaceId)
	);
}

/**
 * Create role assignment
 */
export function assignRole(
	userId: number,
	role: UserRole,
	workspaceId: string = 'default-workspace',
	assignedBy?: number
): void {
	const stmt = db.prepare(`
		INSERT INTO user_roles (user_id, role_name, workspace_id)
		SELECT ?, ?, ?
		WHERE NOT EXISTS (
			SELECT 1 FROM user_roles
			WHERE user_id = ? AND role_name = ? AND workspace_id = ?
		)
	`);

	stmt.run(userId, role, workspaceId, userId, role, workspaceId);
}

/**
 * Remove role assignment
 */
export function removeRole(userId: number, role: UserRole, workspaceId: string): void {
	const stmt = db.prepare(`
		DELETE FROM user_roles
		WHERE user_id = ? AND role_name = ? AND workspace_id = ?
	`);

	stmt.run(userId, role, workspaceId);
}

/**
 * Get all users with their roles
 */
export function getAllUsersWithRoles(workspaceId: string = 'default-workspace'): UserWithRoles[] {
	const users = userRepository.getAll();

	return users.map(user => ({
		...user,
		roles: getUserRoles(user.user_id!, workspaceId),
		workspaceId
	}));
}
