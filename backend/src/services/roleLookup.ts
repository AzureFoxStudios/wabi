import { getUserRoles } from "../auth/roleMiddleware.js";
import { DEFAULT_WORKSPACE_ID } from "../constants.js";
import { stateRbacStore } from "../state-plane/index.js";

export interface ComputedRoleInfo {
  roles: string[];
  highestRole: string;
  roleColor: string | null;
}

export interface RoleStyleMeta {
  priority: number;
  color: string | null;
}

export interface WorkspaceRoleLookup {
  workspaceId: string;
  roleStylesByName: Map<string, RoleStyleMeta>;
  roleInfoByUserId: Map<number, ComputedRoleInfo>;
}

export interface RoleDefinitionView {
  roleName: string;
  displayName: string;
  priority: number;
  color: string | null;
  isHoisted: boolean;
}

export function loadRoleStyleMeta(workspaceId: string = DEFAULT_WORKSPACE_ID): Map<string, RoleStyleMeta> {
  const byName = new Map<string, RoleStyleMeta>();
  for (const row of stateRbacStore.getRoleDefinitions(workspaceId)) {
    byName.set(row.roleName, {
      priority: row.priority,
      color: row.color || null
    });
  }
  return byName;
}

export function computeRoleInfoFromRoles(
  roles: string[],
  roleStylesByName: Map<string, RoleStyleMeta>
): ComputedRoleInfo {
  const sortedRoles = roles.filter(Boolean).sort((a, b) => a.localeCompare(b));
  if (sortedRoles.length === 0) {
    return { roles: ['member'], highestRole: 'member', roleColor: null };
  }

  let highestRole = 'member';
  let highestPriority = Number.NEGATIVE_INFINITY;
  let roleColor: string | null = null;

  for (const role of sortedRoles) {
    const meta = roleStylesByName.get(role);
    const priority = meta?.priority ?? 0;
    if (priority > highestPriority) {
      highestPriority = priority;
      highestRole = role;
    }
    if (!roleColor && meta?.color) {
      roleColor = meta.color;
    }
  }

  return {
    roles: sortedRoles,
    highestRole,
    roleColor
  };
}

export function buildWorkspaceRoleLookup(workspaceId: string = DEFAULT_WORKSPACE_ID): WorkspaceRoleLookup {
  const roleStylesByName = loadRoleStyleMeta(workspaceId);
  const assignments = stateRbacStore.getWorkspaceRoleAssignments(workspaceId);
  const rolesByUserId = new Map<number, string[]>();

  for (const assignment of assignments) {
    const existing = rolesByUserId.get(assignment.userId) || [];
    existing.push(assignment.role);
    rolesByUserId.set(assignment.userId, existing);
  }

  const roleInfoByUserId = new Map<number, ComputedRoleInfo>();
  for (const [userId, roles] of rolesByUserId.entries()) {
    roleInfoByUserId.set(userId, computeRoleInfoFromRoles(roles, roleStylesByName));
  }

  return {
    workspaceId,
    roleStylesByName,
    roleInfoByUserId
  };
}

export function getUserRoleInfo(
  dbUserId?: number,
  roleLookup?: WorkspaceRoleLookup
): ComputedRoleInfo {
  if (!dbUserId) return { roles: ['guest'], highestRole: 'guest', roleColor: '#888888' };

  if (roleLookup) {
    const cached = roleLookup.roleInfoByUserId.get(dbUserId);
    if (cached) {
      return cached;
    }

    // Users without an explicit assignment still resolve to the default member role.
    // Avoid per-user fallback reads when building large join snapshots.
    return computeRoleInfoFromRoles(['member'], roleLookup.roleStylesByName);
  }

  const roles = getUserRoles(dbUserId, DEFAULT_WORKSPACE_ID);
  const roleStylesByName = loadRoleStyleMeta(DEFAULT_WORKSPACE_ID);
  return computeRoleInfoFromRoles(roles, roleStylesByName);
}

export function getRoleDefinitions(workspaceId: string = DEFAULT_WORKSPACE_ID): RoleDefinitionView[] {
  return stateRbacStore.getRoleDefinitions(workspaceId).map((row) => ({
    roleName: row.roleName,
    displayName: row.displayName,
    priority: row.priority,
    color: row.color,
    isHoisted: row.isHoisted
  }));
}

export function getRolePriority(roleName: string, workspaceId: string = DEFAULT_WORKSPACE_ID): number {
  return stateRbacStore.getRolePriority(roleName, workspaceId);
}
