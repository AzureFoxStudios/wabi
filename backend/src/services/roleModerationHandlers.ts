interface ModerationUserLike {
  username: string;
  dbUserId?: number | null;
}

interface RoleInfoLike {
  highestRole: string;
}

interface RoleGateMessageLike {
  id: string;
  type?: string;
}

interface AdminSocketLike {
  id: string;
  emit(event: string, payload: unknown): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

interface RegisterRoleModerationHandlersOptions<TUser extends ModerationUserLike, TMessage extends RoleGateMessageLike> {
  socket: AdminSocketLike;
  users: Map<string, TUser>;
  emitRoleDefinitions: (targetSocketId?: string) => void;
  getUserRoleInfo: (dbUserId: number) => RoleInfoLike;
  getRolePriority: (roleName: string) => number;
  assignRole: (targetUserId: number, roleName: string) => void;
  removeRole: (targetUserId: number, roleName: string) => void;
  syncDbUserRoleState: (dbUserId: number) => void;
  countOwners: () => number;
  findUserById: (dbUserId: number) => { username: string } | null;
  banTargetUser: (targetUserId: number, notification: string) => void;
  setRoleDisplayName: (roleName: string, displayName: string) => void;
  emitEmojiRoleRules: (targetSocketId?: string) => void;
  roleExists: (roleName: string) => boolean;
  getChannelMessages: (channelId: string) => TMessage[];
  createEmojiRoleRule: (payload: {
    channelId: string;
    messageId: string;
    emojiId: string;
    roleName: string;
    removeOnUnreact: boolean;
  }) => void;
  deleteEmojiRoleRule: (ruleId: number) => void;
  logEnabled: boolean;
  log: (...args: unknown[]) => void;
}

export function registerRoleModerationHandlers<TUser extends ModerationUserLike, TMessage extends RoleGateMessageLike>({
  socket,
  users,
  emitRoleDefinitions,
  getUserRoleInfo,
  getRolePriority,
  assignRole,
  removeRole,
  syncDbUserRoleState,
  countOwners,
  findUserById,
  banTargetUser,
  setRoleDisplayName,
  emitEmojiRoleRules,
  roleExists,
  getChannelMessages,
  createEmojiRoleRule,
  deleteEmojiRoleRule,
  logEnabled,
  log
}: RegisterRoleModerationHandlersOptions<TUser, TMessage>): void {
  socket.on("assign-role", (data: { targetUserId: number; roleName: string }) => {
    const user = users.get(socket.id);
    if (!user || !user.dbUserId) return;

    const myRoleInfo = getUserRoleInfo(user.dbUserId);
    if (!['owner', 'admin'].includes(myRoleInfo.highestRole)) {
      socket.emit("channel-error", "Insufficient permissions to assign roles");
      return;
    }

    try {
      assignRole(data.targetUserId, data.roleName);
      syncDbUserRoleState(data.targetUserId);
    } catch {
      socket.emit("channel-error", "Failed to assign role");
    }
  });

  socket.on("remove-role", (data: { targetUserId: number; roleName: string }) => {
    const user = users.get(socket.id);
    if (!user || !user.dbUserId) return;

    const myRoleInfo = getUserRoleInfo(user.dbUserId);
    if (!['owner', 'admin'].includes(myRoleInfo.highestRole)) {
      socket.emit("channel-error", "Insufficient permissions to remove roles");
      return;
    }

    try {
      if (data.roleName === 'owner' && countOwners() <= 1) {
        socket.emit("channel-error", "Cannot remove the last owner");
        return;
      }

      removeRole(data.targetUserId, data.roleName);
      syncDbUserRoleState(data.targetUserId);
    } catch {
      socket.emit("channel-error", "Failed to remove role");
    }
  });

  socket.on("ban-user", (data: { targetUserId: number; reason?: string }) => {
    const user = users.get(socket.id);
    if (!user || !user.dbUserId) return;

    const myRoleInfo = getUserRoleInfo(user.dbUserId);
    if (!['owner', 'admin', 'mod'].includes(myRoleInfo.highestRole)) {
      socket.emit("channel-error", "Insufficient permissions to ban users");
      return;
    }

    if (!Number.isFinite(data.targetUserId)) {
      socket.emit("channel-error", "Invalid target user");
      return;
    }

    if (data.targetUserId === user.dbUserId) {
      socket.emit("channel-error", "You cannot ban yourself");
      return;
    }

    const targetUser = findUserById(data.targetUserId);
    if (!targetUser) {
      socket.emit("channel-error", "Target user not found");
      return;
    }

    const targetRoleInfo = getUserRoleInfo(data.targetUserId);
    if (targetRoleInfo.highestRole === 'owner') {
      socket.emit("channel-error", "Owner account cannot be banned");
      return;
    }

    const myPriority = getRolePriority(myRoleInfo.highestRole);
    const targetPriority = getRolePriority(targetRoleInfo.highestRole);
    if (myPriority <= targetPriority) {
      socket.emit("channel-error", "You cannot ban a user with equal or higher role");
      return;
    }

    try {
      banTargetUser(data.targetUserId, "Your account has been banned.");
      socket.emit("channel-error", `User ${targetUser.username} banned.`);

      if (logEnabled) {
        const reason = (data.reason || '').trim();
        log(`[Moderation] ${user.username} banned user ${targetUser.username}${reason ? ` | reason: ${reason}` : ''}`);
      }
    } catch {
      socket.emit("channel-error", "Failed to ban user");
    }
  });

  socket.on("get-role-definitions", () => {
    emitRoleDefinitions(socket.id);
  });

  socket.on("set-role-display-name", (data: { roleName: string; displayName: string }) => {
    const user = users.get(socket.id);
    if (!user || !user.dbUserId) return;

    const myRoleInfo = getUserRoleInfo(user.dbUserId);
    if (!['owner', 'admin'].includes(myRoleInfo.highestRole)) {
      socket.emit("channel-error", "Insufficient permissions to rename roles");
      return;
    }

    const nextDisplay = (data.displayName || '').trim();
    if (nextDisplay.length < 1 || nextDisplay.length > 40) {
      socket.emit("channel-error", "Role display names must be 1-40 characters");
      return;
    }

    try {
      setRoleDisplayName(data.roleName, nextDisplay);
      emitRoleDefinitions();
    } catch {
      socket.emit("channel-error", "Failed to update role display name");
    }
  });

  socket.on("get-emoji-role-rules", () => {
    emitEmojiRoleRules(socket.id);
  });

  socket.on("set-emoji-role-rule", (data: {
    channelId: string;
    messageId: string;
    emojiId: string;
    roleName: string;
    removeOnUnreact?: boolean;
  }) => {
    const user = users.get(socket.id);
    if (!user || !user.dbUserId) return;

    const myRoleInfo = getUserRoleInfo(user.dbUserId);
    if (!['owner', 'admin'].includes(myRoleInfo.highestRole)) {
      socket.emit("channel-error", "Insufficient permissions to manage emoji role rules");
      return;
    }

    if (!data.channelId || !data.messageId || !data.emojiId || !data.roleName) {
      socket.emit("channel-error", "Channel, role-gate message, emoji, and role are required");
      return;
    }

    if (data.roleName === 'owner') {
      socket.emit("channel-error", "Owner role cannot be automated");
      return;
    }

    if (!roleExists(data.roleName)) {
      socket.emit("channel-error", "Unknown role");
      return;
    }

    const gateMessages = getChannelMessages(data.channelId);
    const gateMessage = gateMessages.find((message) => message.id === data.messageId);
    if (!gateMessage || gateMessage.type !== 'role_gate') {
      socket.emit("channel-error", "Selected message is not a role-gate post");
      return;
    }

    try {
      createEmojiRoleRule({
        channelId: data.channelId,
        messageId: data.messageId,
        emojiId: data.emojiId,
        roleName: data.roleName,
        removeOnUnreact: Boolean(data.removeOnUnreact)
      });
      emitEmojiRoleRules();
    } catch {
      socket.emit("channel-error", "Failed to add emoji role rule");
    }
  });

  socket.on("delete-emoji-role-rule", (data: { ruleId: number }) => {
    const user = users.get(socket.id);
    if (!user || !user.dbUserId) return;

    const myRoleInfo = getUserRoleInfo(user.dbUserId);
    if (!['owner', 'admin'].includes(myRoleInfo.highestRole)) {
      socket.emit("channel-error", "Insufficient permissions to manage emoji role rules");
      return;
    }

    try {
      deleteEmojiRoleRule(data.ruleId);
      emitEmojiRoleRules();
    } catch {
      socket.emit("channel-error", "Failed to delete emoji role rule");
    }
  });
}
