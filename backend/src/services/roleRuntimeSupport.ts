interface RoleRuntimeUserLike {
  dbUserId?: number | null;
  roles?: string[];
  highestRole?: string;
  roleColor?: string | null;
}

interface RoleRuntimeMessageLike {
  id: string;
  type?: string;
}

interface RoleDefinitionServerLike {
  to(room: string): { emit(event: string, payload: unknown): boolean };
}

interface EmojiRoleRuleRow {
  id: number;
  channel_id: string | null;
  message_id: string | null;
  emoji_id: string;
  role_name: string;
  remove_on_unreact: number;
  enabled: number;
}

interface EmojiRoleAssignmentRow {
  role_name: string;
  remove_on_unreact: number;
}

interface CreateRoleRuntimeSupportOptions<TUser extends RoleRuntimeUserLike, TMessage extends RoleRuntimeMessageLike> {
  io: RoleDefinitionServerLike;
  users: Map<string, TUser>;
  channelMessages: Map<string, TMessage[]>;
  getRoleDefinitions: () => unknown;
  getUserRoleInfo: (dbUserId: number) => { roles: string[]; highestRole: string; roleColor: string | null };
  emitGlobalEvent: (event: string, payload: unknown) => void;
  listEmojiRoleRules: () => EmojiRoleRuleRow[];
  listMatchingEmojiRoleAssignments: (
    channelId: string,
    messageId: string,
    emojiId: string
  ) => EmojiRoleAssignmentRow[];
  assignRole: (targetUserId: number, roleName: string) => void;
  removeRole: (targetUserId: number, roleName: string) => void;
}

export function createRoleRuntimeSupport<TUser extends RoleRuntimeUserLike, TMessage extends RoleRuntimeMessageLike>({
  io,
  users,
  channelMessages,
  getRoleDefinitions,
  getUserRoleInfo,
  emitGlobalEvent,
  listEmojiRoleRules,
  listMatchingEmojiRoleAssignments,
  assignRole,
  removeRole
}: CreateRoleRuntimeSupportOptions<TUser, TMessage>) {
  const emitRoleDefinitions = (targetSocketId?: string) => {
    const payload = { roles: getRoleDefinitions() };
    if (targetSocketId) {
      io.to(targetSocketId).emit('role-definitions-updated', payload);
    } else {
      emitGlobalEvent('role-definitions-updated', payload);
    }
  };

  const syncDbUserRoleState = (dbUserId: number) => {
    const newRoleInfo = getUserRoleInfo(dbUserId);
    for (const [socketId, user] of users.entries()) {
      if (user.dbUserId !== dbUserId) continue;
      user.roles = newRoleInfo.roles;
      user.highestRole = newRoleInfo.highestRole;
      user.roleColor = newRoleInfo.roleColor;
      users.set(socketId, user);
    }
    emitGlobalEvent('user-role-changed', {
      userId: `user-${dbUserId}`,
      dbUserId,
      roles: newRoleInfo.roles,
      highestRole: newRoleInfo.highestRole,
      roleColor: newRoleInfo.roleColor
    });
  };

  const emitEmojiRoleRules = (targetSocketId?: string) => {
    const rules = listEmojiRoleRules().map((rule) => ({
      id: rule.id,
      channelId: rule.channel_id || '',
      messageId: rule.message_id || '',
      emojiId: rule.emoji_id,
      roleName: rule.role_name,
      removeOnUnreact: rule.remove_on_unreact === 1,
      enabled: rule.enabled === 1
    }));
    const payload = { rules };
    if (targetSocketId) {
      io.to(targetSocketId).emit('emoji-role-rules-updated', payload);
    } else {
      emitGlobalEvent('emoji-role-rules-updated', payload);
    }
  };

  const applyEmojiRoleRules = (
    targetDbUserId: number | undefined,
    channelId: string,
    messageId: string,
    emojiId: string,
    removed: boolean
  ) => {
    if (!targetDbUserId) return;
    const targetMessage = (channelMessages.get(channelId) || []).find((message) => message.id === messageId);
    if (!targetMessage || targetMessage.type !== 'role_gate') return;

    const rules = listMatchingEmojiRoleAssignments(channelId, messageId, emojiId);
    if (rules.length === 0) return;

    for (const rule of rules) {
      if (rule.role_name === 'owner') continue;
      if (removed) {
        if (rule.remove_on_unreact === 1) {
          removeRole(targetDbUserId, rule.role_name);
        }
      } else {
        assignRole(targetDbUserId, rule.role_name);
      }
    }

    syncDbUserRoleState(targetDbUserId);
  };

  return {
    emitRoleDefinitions,
    syncDbUserRoleState,
    emitEmojiRoleRules,
    applyEmojiRoleRules
  };
}
