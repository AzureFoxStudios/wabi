import db from '../database.js';
import { DEFAULT_WORKSPACE_ID } from '../../constants.js';
import { stateRbacStore } from '../../state-plane/index.js';

/**
 * Role information returned for a user
 */
export interface RoleInfo {
  roles: string[];
  highestRole: string;
  roleColor: string | null;
}

/**
 * Role definition for display
 */
export interface RoleDefinition {
  roleName: string;
  displayName: string;
  priority: number;
  color: string | null;
  isHoisted: boolean;
}

/**
 * Emoji role rule definition
 */
export interface EmojiRoleRule {
  id: number;
  channelId: string;
  messageId: string;
  emojiId: string;
  roleName: string;
  removeOnUnreact: boolean;
  enabled: boolean;
}

/**
 * Get role info for a user (roles, highest role, display color)
 */
export function getUserRoleInfo(dbUserId?: number): RoleInfo {
  if (!dbUserId) {
    return { roles: ['guest'], highestRole: 'guest', roleColor: '#888888' };
  }

  const roles = getUserRoles(dbUserId);
  if (roles.length === 0) {
    return { roles: ['member'], highestRole: 'member', roleColor: null };
  }

  // Get role priorities from DB
  const roleRows = db.prepare(
    'SELECT role_name, priority, color FROM roles WHERE role_name IN (' + roles.map(() => '?').join(',') + ') ORDER BY priority DESC'
  ).all(...roles) as { role_name: string; priority: number; color: string | null }[];

  const highestRole = roleRows[0]?.role_name || 'member';
  const roleColor = roleRows.find(r => r.color)?.color || null;

  return { roles: roles.length > 0 ? roles : ['member'], highestRole, roleColor };
}

/**
 * Get all roles for a user
 */
export function getUserRoles(userId: number, workspaceId: string = DEFAULT_WORKSPACE_ID): string[] {
  return stateRbacStore.getUserRoles(userId, workspaceId);
}

/**
 * Get role definitions for a workspace
 */
export function getRoleDefinitions(workspaceId: string = DEFAULT_WORKSPACE_ID): RoleDefinition[] {
  const rows = db.prepare(`
    SELECT role_name, COALESCE(display_name, role_name) as display_name, priority, color, is_hoisted
    FROM roles
    WHERE workspace_id = ?
    ORDER BY priority DESC
  `).all(workspaceId) as Array<{
    role_name: string;
    display_name: string;
    priority: number;
    color: string | null;
    is_hoisted: number;
  }>;

  return rows.map(row => ({
    roleName: row.role_name,
    displayName: row.display_name,
    priority: row.priority,
    color: row.color,
    isHoisted: row.is_hoisted === 1
  }));
}

/**
 * Get priority of a role
 */
export function getRolePriority(roleName: string, workspaceId: string = DEFAULT_WORKSPACE_ID): number {
  const row = db.prepare(`
    SELECT priority FROM roles
    WHERE role_name = ? AND workspace_id = ?
    LIMIT 1
  `).get(roleName, workspaceId) as { priority?: number } | undefined;
  
  return row?.priority ?? 0;
}

/**
 * Check if workspace has an owner
 */
export function workspaceHasOwner(): boolean {
  return stateRbacStore.workspaceHasOwner('default-workspace');
}

/**
 * Get all emoji role rules for a workspace
 */
export function getEmojiRoleRules(workspaceId: string = DEFAULT_WORKSPACE_ID): EmojiRoleRule[] {
  return db.prepare(`
    SELECT id, channel_id, message_id, emoji_id, role_name, remove_on_unreact, enabled
    FROM emoji_role_rules
    WHERE workspace_id = ?
      AND channel_id IS NOT NULL AND channel_id != ''
      AND message_id IS NOT NULL AND message_id != ''
    ORDER BY id DESC
  `).all(workspaceId) as EmojiRoleRule[];
}

/**
 * Add an emoji role rule
 */
export function addEmojiRoleRule(
  channelId: string,
  messageId: string,
  emojiId: string,
  roleName: string,
  removeOnUnreact: boolean = false,
  workspaceId: string = DEFAULT_WORKSPACE_ID
): void {
  db.prepare(`
    INSERT INTO emoji_role_rules (channel_id, message_id, emoji_id, role_name, remove_on_unreact, workspace_id, enabled)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(channelId, messageId, emojiId, roleName, removeOnUnreact ? 1 : 0, workspaceId);
}

/**
 * Delete an emoji role rule
 */
export function deleteEmojiRoleRule(ruleId: number, workspaceId: string = DEFAULT_WORKSPACE_ID): void {
  db.prepare('DELETE FROM emoji_role_rules WHERE id = ? AND workspace_id = ?')
    .run(ruleId, workspaceId);
}

/**
 * Get emoji role rules for a specific channel and message
 */
export function getEmojiRoleRulesForMessage(
  channelId: string,
  messageId: string,
  emojiId: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID
): { role_name: string; remove_on_unreact: number }[] {
  return db.prepare(`
    SELECT role_name, remove_on_unreact
    FROM emoji_role_rules
    WHERE workspace_id = ? AND enabled = 1 AND channel_id = ? AND message_id = ? AND emoji_id = ?
  `).all(workspaceId, channelId, messageId, emojiId) as { role_name: string; remove_on_unreact: number }[];
}

/**
 * Set role display name
 */
export function setRoleDisplayName(
  roleName: string,
  displayName: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID
): void {
  const nextDisplay = (displayName || '').trim();
  if (nextDisplay.length < 1 || nextDisplay.length > 40) {
    throw new Error('Role display names must be 1-40 characters');
  }
  
  db.prepare(`
    UPDATE roles
    SET display_name = ?
    WHERE role_name = ? AND workspace_id = ?
  `).run(nextDisplay, roleName, workspaceId);
}

/**
 * Check if a role exists
 */
export function roleExists(roleName: string, workspaceId: string = DEFAULT_WORKSPACE_ID): boolean {
  const result = db.prepare('SELECT 1 FROM roles WHERE role_name = ? AND workspace_id = ? LIMIT 1')
    .get(roleName, workspaceId);
  return Boolean(result);
}

/**
 * Get all roles in a workspace
 */
export function getAllRoles(workspaceId: string = DEFAULT_WORKSPACE_ID): { role_name: string }[] {
  return db.prepare('SELECT role_name FROM roles WHERE workspace_id = ? ORDER BY priority DESC')
    .all(workspaceId) as { role_name: string }[];
}
