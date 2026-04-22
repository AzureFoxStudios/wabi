interface UsernameFontLike {
  family?: string;
  size?: string;
  weight?: string;
  style?: string;
}

interface SessionRecord {
  userId: string;
  username: string;
  color: string;
  profilePicture?: string;
  createdAt: number;
  usernameFont?: UsernameFontLike;
}

interface UserLike {
  id: string;
  username: string;
  handle?: string;
  color: string;
  status?: string;
  profilePicture?: string | null;
  joinedAt?: number;
  dbUserId?: number;
  roles?: string[];
  highestRole?: string;
  roleColor?: string | null;
  usernameFont?: UsernameFontLike;
}

interface ChannelLike {
  id: string;
  persistMessages?: boolean;
}

interface RoleInfoLike {
  roles: string[];
  highestRole?: string;
  roleColor?: string | null;
}

interface ProfileUpdatePayload {
  status?: 'active' | 'away' | 'busy';
  profilePicture?: string;
  username?: string;
  usernameFont?: UsernameFontLike;
}

interface ProfileUpdateResult {
  success: boolean;
  error?: string;
}

interface SessionProfileSocketLike {
  id: string;
  emit(event: string, payload: unknown): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

interface RegisterSessionProfileHandlersOptions<TUser extends UserLike, TChannel extends ChannelLike, TMessage> {
  socket: SessionProfileSocketLike;
  users: Map<string, TUser>;
  sessions: Map<string, SessionRecord>;
  userCurrentChannel: Map<string, string>;
  getSocketStableId: () => string;
  isSocketRegistered: () => boolean;
  getSocketSessionId: () => string | null | undefined;
  getSocketDbUserId: () => number | undefined;
  setRegisteredSocket: (dbUserId: number, socketId: string) => void;
  registerStateMeshSocketLease: (stableUserId: string, dbUserId?: number) => unknown;
  setSocketMeshLeaseConnectedAt: (value: unknown) => void;
  getSocketMeshPresenceConnectedAt: () => unknown;
  setSocketMeshPresenceConnectedAt: (value: unknown) => void;
  loadRegisteredRejoinProfile: (socketSessionId: string) => { usernameFont?: UsernameFontLike; handle?: string } | null;
  ensureWorkspaceOwnerForRegisteredUser: (dbUserId: number, username: string) => RoleInfoLike;
  loadUserChannelsFromDB: (stableUserId: string) => TChannel[];
  enrichDMChannels: (channels: TChannel[], stableUserId: string) => unknown[];
  upsertPresenceLeaseForUser: (user: TUser | undefined, connectedAt: unknown) => unknown;
  buildDistributedUsersSnapshot: () => unknown[];
  buildServerMembersSnapshot: () => unknown[];
  getVoiceStatePayload: () => unknown;
  getEmotes: () => unknown[];
  getAllEmojis: () => unknown[];
  getRoleDefinitions: () => unknown;
  getMessagePurgeVersion: () => unknown;
  deliverOfflineMessages: (socket: SessionProfileSocketLike, dbUserId: number) => void | Promise<void>;
  emitUserJoinedSideEffects: (user: TUser, source: string) => void;
  findRegisteredUserByUsername: (username: string) => { user_id?: number } | null;
  persistRegisteredProfileUpdate: (socketSessionId: string, user: TUser) => void;
  recordProfileUpdated: (changedFields: string[], profilePictureSet: boolean) => void;
  emitProfileUpdated: (user: TUser) => void;
  getAccessibleChannel: (channelId: string) => TChannel | undefined;
  loadRecentChannelMessages: (channelId: string, persistMessages: boolean) => { messages: TMessage[]; hasMore: boolean };
  logAccessDenied: (channelId: string) => void;
  logEnabled: boolean;
  log: (...args: unknown[]) => void;
}

export function registerSessionProfileHandlers<TUser extends UserLike, TChannel extends ChannelLike, TMessage>({
  socket,
  users,
  sessions,
  userCurrentChannel,
  getSocketStableId,
  isSocketRegistered,
  getSocketSessionId,
  getSocketDbUserId,
  setRegisteredSocket,
  registerStateMeshSocketLease,
  setSocketMeshLeaseConnectedAt,
  getSocketMeshPresenceConnectedAt,
  setSocketMeshPresenceConnectedAt,
  loadRegisteredRejoinProfile,
  ensureWorkspaceOwnerForRegisteredUser,
  loadUserChannelsFromDB,
  enrichDMChannels,
  upsertPresenceLeaseForUser,
  buildDistributedUsersSnapshot,
  buildServerMembersSnapshot,
  getVoiceStatePayload,
  getEmotes,
  getAllEmojis,
  getRoleDefinitions,
  getMessagePurgeVersion,
  deliverOfflineMessages,
  emitUserJoinedSideEffects,
  findRegisteredUserByUsername,
  persistRegisteredProfileUpdate,
  recordProfileUpdated,
  emitProfileUpdated,
  getAccessibleChannel,
  loadRecentChannelMessages,
  logAccessDenied,
  logEnabled,
  log
}: RegisterSessionProfileHandlersOptions<TUser, TChannel, TMessage>): void {
  socket.on("rejoin", (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) {
      socket.emit("rejoin-failed", { reason: "Invalid session" });
      return;
    }

    session.userId = socket.id;
    sessions.set(sessionId, session);

    let usernameFont = session.usernameFont;
    let rejoinHandle: string | undefined;
    let rejoinRoleInfo: RoleInfoLike = { roles: [], highestRole: undefined, roleColor: undefined };

    const socketSessionId = getSocketSessionId();
    if (isSocketRegistered() && socketSessionId) {
      const registeredProfile = loadRegisteredRejoinProfile(socketSessionId);
      if (registeredProfile) {
        usernameFont = registeredProfile.usernameFont ?? usernameFont;
        rejoinHandle = registeredProfile.handle;
      }
    }

    const rejoinDbUserId = isSocketRegistered() ? getSocketDbUserId() : undefined;
    if (rejoinDbUserId) {
      rejoinRoleInfo = ensureWorkspaceOwnerForRegisteredUser(rejoinDbUserId, session.username);
    }

    const rejoinConnectedAt = Date.now();
    users.set(socket.id, {
      id: socket.id,
      username: session.username,
      handle: rejoinHandle,
      color: session.color,
      status: 'active',
      profilePicture: session.profilePicture,
      joinedAt: rejoinConnectedAt,
      dbUserId: rejoinDbUserId,
      roles: rejoinRoleInfo.roles,
      highestRole: rejoinRoleInfo.highestRole,
      roleColor: rejoinRoleInfo.roleColor,
      usernameFont
    } as TUser);

    if (rejoinDbUserId) {
      setRegisteredSocket(rejoinDbUserId, socket.id);
    }

    const rejoinStableId = getSocketStableId();
    setSocketMeshLeaseConnectedAt(registerStateMeshSocketLease(rejoinStableId, rejoinDbUserId));
    const rejoinChannels = loadUserChannelsFromDB(rejoinStableId);
    const enrichedRejoinChannels = enrichDMChannels(rejoinChannels, rejoinStableId);
    const rejoinUser = users.get(socket.id);
    setSocketMeshPresenceConnectedAt(upsertPresenceLeaseForUser(rejoinUser, rejoinConnectedAt));

    socket.emit("init", {
      channels: enrichedRejoinChannels,
      users: buildDistributedUsersSnapshot(),
      serverMembers: rejoinDbUserId ? buildServerMembersSnapshot() : undefined,
      voiceState: getVoiceStatePayload(),
      emotes: getEmotes(),
      emojis: getAllEmojis(),
      roleDefinitions: getRoleDefinitions(),
      sessionId,
      messagePurgeVersion: getMessagePurgeVersion()
    });

    if (rejoinDbUserId) {
      void deliverOfflineMessages(socket, rejoinDbUserId);
    }

    if (rejoinUser) {
      emitUserJoinedSideEffects(rejoinUser, 'rejoin_event');
    }

    if (logEnabled) {
      log(`${session.username} rejoined the chat`);
    }
  });

  socket.on("update-profile", (data: ProfileUpdatePayload, callback?: (response: ProfileUpdateResult) => void) => {
    const user = users.get(socket.id);
    if (!user) {
      callback?.({ success: false, error: 'User not found' });
      return;
    }

    if (data.username !== undefined) {
      const nextUsername = data.username.trim();
      if (nextUsername.length < 2 || nextUsername.length > 32) {
        callback?.({ success: false, error: 'Display name must be 2-32 characters' });
        return;
      }

      const duplicateOnline = Array.from(users.entries()).find(([id, existing]) =>
        id !== socket.id && existing.username.toLowerCase() === nextUsername.toLowerCase()
      );
      if (duplicateOnline) {
        callback?.({ success: false, error: 'That display name is already in use' });
        return;
      }

      const existingRegistered = findRegisteredUserByUsername(nextUsername);
      if (existingRegistered && existingRegistered.user_id !== user.dbUserId) {
        callback?.({ success: false, error: 'That display name is already registered' });
        return;
      }

      user.username = nextUsername;
    }

    if (data.status) {
      user.status = data.status;
    }
    if (data.profilePicture !== undefined) {
      user.profilePicture = data.profilePicture;
    }
    if (data.usernameFont !== undefined) {
      user.usernameFont = data.usernameFont;
    }

    users.set(socket.id, user);
    setSocketMeshPresenceConnectedAt(
      upsertPresenceLeaseForUser(user, getSocketMeshPresenceConnectedAt() ?? null)
    );

    const socketSessionId = getSocketSessionId();
    if (isSocketRegistered() && socketSessionId) {
      try {
        persistRegisteredProfileUpdate(socketSessionId, user);
      } catch (error) {
        console.error('[Error] Failed to update profile picture in database:', error);
        callback?.({ success: false, error: 'Database update failed' });
        return;
      }
    }

    for (const [sessionId, session] of sessions.entries()) {
      if (session.userId !== socket.id) continue;
      session.username = user.username;
      session.profilePicture = user.profilePicture ?? undefined;
      session.usernameFont = user.usernameFont;
      sessions.set(sessionId, session);
      break;
    }

    const changedFields: string[] = [];
    if (data.username !== undefined) changedFields.push('username');
    if (data.status !== undefined) changedFields.push('status');
    if (data.profilePicture !== undefined) changedFields.push('profilePicture');
    if (data.usernameFont !== undefined) changedFields.push('usernameFont');
    if (changedFields.length > 0) {
      recordProfileUpdated(changedFields, Boolean(user.profilePicture));
    }

    emitProfileUpdated(user);

    if (logEnabled) {
      log(`${user.username} updated profile: status=${user.status}`);
    }
    callback?.({ success: true });
  });

  socket.on("join-channel", (channelId: string) => {
    const channel = getAccessibleChannel(channelId);
    if (!channel) {
      logAccessDenied(channelId);
      return;
    }

    userCurrentChannel.set(socket.id, channelId);

    const payload = loadRecentChannelMessages(channelId, channel.persistMessages === true);
    socket.emit("channel-messages", {
      channelId,
      messages: payload.messages,
      hasMore: payload.hasMore
    });

    if (logEnabled) {
      log(`User ${socket.id} joined channel ${channelId}`);
    }
  });
}
