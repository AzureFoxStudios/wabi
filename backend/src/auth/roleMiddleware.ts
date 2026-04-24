import {
	stateUserStore,
	stateRbacStore
} from '../state-plane/index.js';
import { DEFAULT_WORKSPACE_ID } from '../constants.js';

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
export function getUserRoles(userId: number, workspaceId: string = DEFAULT_WORKSPACE_ID): UserRole[] {
	const user = stateUserStore.findById(userId);
	if (!user) return [];

	const result = stateRbacStore.getUserRoles(userId, workspaceId);
	return result.map((role) => role as UserRole);
}

/**
 * Check if user has at least one of the required roles
 */
export function hasRequiredRole(
	userId: number | undefined,
	requiredRoles: UserRole[],
	workspaceId: string = DEFAULT_WORKSPACE_ID
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
	return stateRbacStore.getResourceMinRole(resourceId) as UserRole;
}

/**
 * Check if user can view a resource
 */
export function canViewResource(
	userId: number | undefined,
	resourceId: string,
	workspaceId: string = DEFAULT_WORKSPACE_ID
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
	workspaceId: string = DEFAULT_WORKSPACE_ID
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
	workspaceId: string = DEFAULT_WORKSPACE_ID,
	assignedBy?: number
): void {
	stateRbacStore.assignRole(userId, role, workspaceId, assignedBy);
}

/**
 * Remove role assignment
 */
export function removeRole(userId: number, role: UserRole, workspaceId: string): void {
	stateRbacStore.removeRole(userId, role, workspaceId);
}

/**
 * Get all users with their roles
 */
export function getAllUsersWithRoles(workspaceId: string = DEFAULT_WORKSPACE_ID): UserWithRoles[] {
	const users = stateUserStore.getAll();

	return users.map(user => ({
		...user,
		roles: getUserRoles(user.user_id!, workspaceId),
		workspaceId
	}));
}
