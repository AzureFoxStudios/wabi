import db from '../db/database.js';

export enum PermissionBits {
  VIEW_CHANNEL = 1 << 0,
  SEND_MESSAGES = 1 << 1,
  MANAGE_CHANNELS = 1 << 2,
  MANAGE_ROLES = 1 << 3,
  MANAGE_GROUP_MEMBERS = 1 << 4,
  MANAGE_OVERWRITES = 1 << 5,
  MANAGE_GROUP_AVATAR = 1 << 6,
}

export type PermissionSubjectType = 'everyone' | 'role' | 'user';
export type PermissionScope = 'category' | 'channel' | 'tag_forum';

export interface PermissionOverwriteRecord {
  subject_type: PermissionSubjectType;
  subject_id: string;
  allow_bits: number;
  deny_bits: number;
}

export interface PermissionContext {
  workspaceId?: string;
  categoryId?: string;
  channelId?: string;
  tagId?: string;
}

const DEFAULT_WORKSPACE = 'default-workspace';

function normalizeBits(allowBits: number, denyBits: number): { allowBits: number; denyBits: number } {
  const clampedAllow = allowBits >>> 0;
  let clampedDeny = denyBits >>> 0;
  if ((clampedAllow & clampedDeny) !== 0) {
    clampedDeny |= clampedAllow & clampedDeny;
  }
  return {
    allowBits: clampedAllow & ~clampedDeny,
    denyBits: clampedDeny,
  };
}

function applyOverwrite(allowBits: number, denyBits: number, overwrite: PermissionOverwriteRecord): { allowBits: number; denyBits: number } {
  const normalized = normalizeBits(overwrite.allow_bits, overwrite.deny_bits);
  const nextAllow = (allowBits | normalized.allowBits) & ~normalized.denyBits;
  const nextDeny = denyBits | normalized.denyBits;
  return { allowBits: nextAllow, denyBits: nextDeny };
}

function getRoleBasePermissions(roleNames: string[], workspaceId: string): PermissionOverwriteRecord[] {
  if (roleNames.length === 0) return [];

  const placeholders = roleNames.map(() => '?').join(',');
  return db.prepare(
    `SELECT role_name, allow_bits, deny_bits
     FROM role_base_permissions
     WHERE workspace_id = ? AND role_name IN (${placeholders})`
  ).all(workspaceId, ...roleNames) as Array<{ role_name: string; allow_bits: number; deny_bits: number }>;
}

function getOverwritesForScope(scope: PermissionScope, resourceId: string, workspaceId: string): PermissionOverwriteRecord[] {
  const tableName = scope === 'category'
    ? 'category_overwrites'
    : scope === 'channel'
      ? 'channel_overwrites'
      : 'tag_forum_overwrites';

  const resourceColumn = scope === 'category'
    ? 'category_id'
    : scope === 'channel'
      ? 'channel_id'
      : 'tag_id';

  return db.prepare(
    `SELECT subject_type, subject_id, allow_bits, deny_bits
     FROM ${tableName}
     WHERE workspace_id = ? AND ${resourceColumn} = ?
     ORDER BY
      CASE subject_type WHEN 'everyone' THEN 0 WHEN 'role' THEN 1 WHEN 'user' THEN 2 ELSE 3 END,
      subject_id ASC`
  ).all(workspaceId, resourceId) as PermissionOverwriteRecord[];
}

function selectApplicableOverwrites(
  overwrites: PermissionOverwriteRecord[],
  userId: number,
  roleNames: string[]
): PermissionOverwriteRecord[] {
  const roleSet = new Set(roleNames);
  return overwrites.filter((overwrite) => {
    if (overwrite.subject_type === 'everyone') return true;
    if (overwrite.subject_type === 'user') return overwrite.subject_id === String(userId);
    if (overwrite.subject_type === 'role') return roleSet.has(overwrite.subject_id);
    return false;
  });
}

function getUserRolesForWorkspace(userId: number, workspaceId: string): string[] {
  const rows = db.prepare(
    `SELECT role_name
     FROM user_roles
     WHERE user_id = ? AND workspace_id = ?
     ORDER BY role_name ASC`
  ).all(userId, workspaceId) as Array<{ role_name: string }>;

  if (rows.length === 0) return ['member'];
  return rows.map((row) => row.role_name);
}

export function getEffectivePermissions(
  userId: number,
  resourceId: string,
  context?: PermissionContext
): { allowBits: number; denyBits: number; effectiveBits: number; appliedRoles: string[] } {
  const workspaceId = context?.workspaceId || DEFAULT_WORKSPACE;
  const roleNames = getUserRolesForWorkspace(userId, workspaceId);

  let allowBits = 0;
  let denyBits = 0;

  // 1) Aggregate server role base permissions first.
  const basePermissions = getRoleBasePermissions(roleNames, workspaceId);
  for (const base of basePermissions) {
    const next = applyOverwrite(allowBits, denyBits, {
      subject_type: 'role',
      subject_id: base.role_name,
      allow_bits: base.allow_bits,
      deny_bits: base.deny_bits,
    });
    allowBits = next.allowBits;
    denyBits = next.denyBits;
  }

  // 2) Category overwrites.
  const categoryId = context?.categoryId || (resourceId.startsWith('category:') ? resourceId.slice('category:'.length) : undefined);
  if (categoryId) {
    const categoryOverwrites = selectApplicableOverwrites(getOverwritesForScope('category', categoryId, workspaceId), userId, roleNames);
    for (const overwrite of categoryOverwrites) {
      const next = applyOverwrite(allowBits, denyBits, overwrite);
      allowBits = next.allowBits;
      denyBits = next.denyBits;
    }
  }

  // 3) Channel overwrites.
  const channelId = context?.channelId || (resourceId.startsWith('channel:') ? resourceId.slice('channel:'.length) : resourceId);
  if (channelId) {
    const channelOverwrites = selectApplicableOverwrites(getOverwritesForScope('channel', channelId, workspaceId), userId, roleNames);
    for (const overwrite of channelOverwrites) {
      const next = applyOverwrite(allowBits, denyBits, overwrite);
      allowBits = next.allowBits;
      denyBits = next.denyBits;
    }
  }

  // 4) Tag/forum overwrites.
  const tagId = context?.tagId || (resourceId.startsWith('tag:') ? resourceId.slice('tag:'.length) : undefined);
  if (tagId) {
    const tagOverwrites = selectApplicableOverwrites(getOverwritesForScope('tag_forum', tagId, workspaceId), userId, roleNames);
    for (const overwrite of tagOverwrites) {
      const next = applyOverwrite(allowBits, denyBits, overwrite);
      allowBits = next.allowBits;
      denyBits = next.denyBits;
    }
  }

  const effectiveBits = allowBits & ~denyBits;
  return { allowBits, denyBits, effectiveBits, appliedRoles: roleNames };
}

export function hasPermission(userId: number, resourceId: string, bit: PermissionBits, context?: PermissionContext): boolean {
  const resolved = getEffectivePermissions(userId, resourceId, context);
  return (resolved.effectiveBits & bit) === bit;
}

export function getRolePermissionsPreview(roleNames: string[], resourceId: string, context?: PermissionContext): { allowBits: number; denyBits: number; effectiveBits: number; appliedRoles: string[] } {
  const workspaceId = context?.workspaceId || DEFAULT_WORKSPACE;
  const effectiveRoles = roleNames.length > 0 ? [...new Set(roleNames)].sort() : ['member'];
  let allowBits = 0;
  let denyBits = 0;

  const basePermissions = getRoleBasePermissions(effectiveRoles, workspaceId);
  for (const base of basePermissions) {
    const next = applyOverwrite(allowBits, denyBits, {
      subject_type: 'role',
      subject_id: base.role_name,
      allow_bits: base.allow_bits,
      deny_bits: base.deny_bits,
    });
    allowBits = next.allowBits;
    denyBits = next.denyBits;
  }

  const effectiveBits = allowBits & ~denyBits;
  return { allowBits, denyBits, effectiveBits, appliedRoles: effectiveRoles };
}

export function sanitizeOverwriteBits(allowBits: number, denyBits: number): { allowBits: number; denyBits: number; hadConflict: boolean } {
  const hadConflict = (allowBits & denyBits) !== 0;
  const normalized = normalizeBits(allowBits, denyBits);
  return { ...normalized, hadConflict };
}
