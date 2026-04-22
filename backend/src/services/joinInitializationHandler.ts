interface UsernameFontLike {
  family?: string | null;
  size?: string | null;
  weight?: string | null;
  style?: string | null;
}

interface SessionRecord {
  userId: string;
  username: string;
  color: string;
  profilePicture?: string;
  createdAt: number;
  usernameFont?: UsernameFontLike;
}

interface RegisteredSessionLike {
  user_id?: number | null;
  username: string;
  color?: string | null;
  profile_picture?: string | null;
}

interface RegisteredAccountLike {
  user_id?: number;
  handle?: string;
  username_font_family?: string | null;
  username_font_size?: string | null;
  username_font_weight?: string | null;
  username_font_style?: string | null;
}

interface RoleInfoLike {
  roles: string[];
  highestRole: string;
  roleColor: string | null;
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

interface JoinInitializationSocketLike {
  id: string;
  emit(event: string, payload: unknown): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

interface RegisterJoinInitializationHandlerOptions<
  TUser extends UserLike,
  TChannel,
  TDbUser extends RegisteredAccountLike & { user_id?: number; username: string; color?: string | null; profile_picture?: string | null },
  TRoleLookup
> {
  socket: JoinInitializationSocketLike;
  users: Map<string, TUser>;
  sessions: Map<string, SessionRecord>;
  isSocketRegistered: () => boolean;
  getSocketSessionId: () => string | null | undefined;
  getSocketDbUserId: () => number | undefined;
  getRegisteredSession: () => RegisteredSessionLike | null | undefined;
  getRegisteredAccount: () => TDbUser | null | undefined;
  findRegisteredSessionById: (sessionId: string) => RegisteredSessionLike | null;
  disconnectOtherRegisteredSockets: (dbUserId: number) => void;
  ensureWorkspaceOwnerDuringJoin: (dbUserId: number, username: string) => void;
  getAllDbUsers: () => TDbUser[];
  buildRoleLookup: () => TRoleLookup;
  getUserRoleInfo: (dbUserId?: number, roleLookup?: TRoleLookup) => RoleInfoLike;
  getSocketStableId: () => string;
  setRegisteredSocket: (dbUserId: number, socketId: string) => void;
  registerStateMeshSocketLease: (stableUserId: string, dbUserId?: number) => unknown;
  setSocketMeshLeaseConnectedAt: (value: unknown) => void;
  upsertPresenceLeaseForUser: (user: TUser | undefined, connectedAt: unknown) => unknown;
  setSocketMeshPresenceConnectedAt: (value: unknown) => void;
  loadUserChannelsFromDB: (stableUserId: string, currentHighestRole?: string) => TChannel[];
  enrichDMChannels: (channels: TChannel[], stableUserId: string, registeredUsersByDbId?: Map<number, TDbUser>) => unknown[];
  buildDistributedUsersSnapshot: (allDbUsers?: TDbUser[], roleLookup?: TRoleLookup) => unknown[];
  buildServerMembersSnapshot: (allDbUsers?: TDbUser[], roleLookup?: TRoleLookup) => unknown[];
  getVoiceStatePayload: () => unknown;
  getEmotes: () => unknown[];
  getRoleDefinitions: () => unknown;
  getMessagePurgeVersion: () => unknown;
  getStatePlaneEffectiveMode: () => string;
  deliverOfflineMessages: (socket: JoinInitializationSocketLike, dbUserId: number | undefined) => Promise<void>;
  emitUserJoinedBroadcast: (user: TUser, source: string) => void;
  emitUserJoinedHooks: (user: TUser) => void;
  generateSessionId: () => string;
  logEnabled: boolean;
  log: (...args: unknown[]) => void;
}

export function registerJoinInitializationHandler<
  TUser extends UserLike,
  TChannel,
  TDbUser extends RegisteredAccountLike & { user_id?: number; username: string; color?: string | null; profile_picture?: string | null },
  TRoleLookup
>({
  socket,
  users,
  sessions,
  isSocketRegistered,
  getSocketSessionId,
  getSocketDbUserId,
  getRegisteredSession,
  getRegisteredAccount,
  findRegisteredSessionById,
  disconnectOtherRegisteredSockets,
  ensureWorkspaceOwnerDuringJoin,
  getAllDbUsers,
  buildRoleLookup,
  getUserRoleInfo,
  getSocketStableId,
  setRegisteredSocket,
  registerStateMeshSocketLease,
  setSocketMeshLeaseConnectedAt,
  upsertPresenceLeaseForUser,
  setSocketMeshPresenceConnectedAt,
  loadUserChannelsFromDB,
  enrichDMChannels,
  buildDistributedUsersSnapshot,
  buildServerMembersSnapshot,
  getVoiceStatePayload,
  getEmotes,
  getRoleDefinitions,
  getMessagePurgeVersion,
  getStatePlaneEffectiveMode,
  deliverOfflineMessages,
  emitUserJoinedBroadcast,
  emitUserJoinedHooks,
  generateSessionId,
  logEnabled,
  log
}: RegisterJoinInitializationHandlerOptions<TUser, TChannel, TDbUser, TRoleLookup>): void {
  socket.on("join", async (username: string) => {
    const joinTraceEnabled =
      process.env.WABI_JOIN_TRACE &&
      ['1', 'true', 'yes', 'on'].includes(process.env.WABI_JOIN_TRACE.trim().toLowerCase());
    const joinProfileEnabled =
      getStatePlaneEffectiveMode() === 'stdb_primary' &&
      Boolean(joinTraceEnabled);
    const joinStartedAt = joinProfileEnabled ? Date.now() : 0;
    const joinMarks: string[] = [];
    const markJoinStep = (label: string) => {
      if (!joinProfileEnabled) return;
      const elapsed = Date.now() - joinStartedAt;
      joinMarks.push(`${label}=${elapsed}ms`);
      console.log(`[JoinTrace] user=${username} step=${label} elapsed=${elapsed}ms`);
    };

    if (isSocketRegistered() && getSocketSessionId()) {
      const dbSession =
        getRegisteredSession() ||
        findRegisteredSessionById(getSocketSessionId()!);
      markJoinStep('session_lookup');

      if (dbSession) {
        const dbUserId = getSocketDbUserId();
        if (typeof dbUserId === 'number') {
          disconnectOtherRegisteredSockets(dbUserId);
        }
        markJoinStep('disconnect_duplicates');

        if (dbSession.user_id) {
          ensureWorkspaceOwnerDuringJoin(dbSession.user_id, dbSession.username);
        }
        markJoinStep('owner_check');

        const allDbUsers = getAllDbUsers();
        markJoinStep('load_users');
        const registeredUsersByDbId = new Map(
          allDbUsers
            .filter((user) => typeof user.user_id === 'number')
            .map((user) => [user.user_id as number, user])
        );
        const registeredUserRecord =
          getRegisteredAccount() ||
          (dbSession.user_id ? (registeredUsersByDbId.get(dbSession.user_id) || null) : null);
        const roleLookup = buildRoleLookup();
        markJoinStep('build_role_lookup');

        const registeredUsername = dbSession.username;
        const registeredColor = dbSession.color || `#${Math.floor(Math.random()*16777215).toString(16)}`;
        const registeredProfilePic = dbSession.profile_picture;

        let usernameFont = undefined;
        if (registeredUserRecord) {
          usernameFont = {
            family: registeredUserRecord.username_font_family,
            size: registeredUserRecord.username_font_size,
            weight: registeredUserRecord.username_font_weight,
            style: registeredUserRecord.username_font_style
          };
        }

        const registeredHandle = registeredUserRecord?.handle;
        const roleInfo = getUserRoleInfo(dbUserId, roleLookup);

        const registeredConnectedAt = Date.now();
        users.set(socket.id, {
          id: socket.id,
          username: registeredUsername,
          handle: registeredHandle,
          color: registeredColor,
          status: 'active',
          profilePicture: registeredProfilePic,
          joinedAt: registeredConnectedAt,
          dbUserId,
          roles: roleInfo.roles,
          highestRole: roleInfo.highestRole,
          roleColor: roleInfo.roleColor,
          usernameFont
        } as TUser);

        if (dbUserId) {
          setRegisteredSocket(dbUserId, socket.id);
        }

        const stableId = getSocketStableId();
        setSocketMeshLeaseConnectedAt(registerStateMeshSocketLease(stableId, dbUserId));
        const userChannels = loadUserChannelsFromDB(stableId, roleInfo.highestRole);
        markJoinStep('load_channels');
        const enrichedChannels = enrichDMChannels(userChannels, stableId, registeredUsersByDbId);
        markJoinStep('enrich_channels');

        const joinedUser = users.get(socket.id);
        setSocketMeshPresenceConnectedAt(upsertPresenceLeaseForUser(joinedUser, registeredConnectedAt));
        const distributedUsers = buildDistributedUsersSnapshot(allDbUsers, roleLookup);
        const serverMembers = buildServerMembersSnapshot(allDbUsers, roleLookup);
        markJoinStep('build_init_payload');
        socket.emit("init", {
          channels: enrichedChannels,
          users: distributedUsers,
          serverMembers,
          voiceState: getVoiceStatePayload(),
          emotes: getEmotes(),
          roleDefinitions: getRoleDefinitions(),
          sessionId: getSocketSessionId(),
          messagePurgeVersion: getMessagePurgeVersion()
        });
        markJoinStep('emit_init');

        if (joinProfileEnabled) {
          console.log(`[JoinTrace] user=${registeredUsername} total=${Date.now() - joinStartedAt}ms ${joinMarks.join(' ')}`);
        }

        await deliverOfflineMessages(socket, dbUserId);

        if (joinedUser) {
          emitUserJoinedBroadcast(joinedUser, 'join_registered');
          emitUserJoinedHooks(joinedUser);
        }

        if (logEnabled) {
          log(`${registeredUsername} joined as registered user`);
        }
        return;
      }
    }

    let existingSession: { sessionId: string; session: SessionRecord } | null = null;
    for (const [sessionId, session] of sessions.entries()) {
      if (session.username === username) {
        existingSession = { sessionId, session };
        break;
      }
    }

    if (existingSession) {
      const { sessionId, session } = existingSession;
      session.userId = socket.id;
      sessions.set(sessionId, session);

      const resumedGuestConnectedAt = Date.now();
      users.set(socket.id, {
        id: socket.id,
        username: session.username,
        color: session.color,
        status: 'active',
        profilePicture: session.profilePicture,
        joinedAt: resumedGuestConnectedAt
      } as TUser);

      const guestChannels = loadUserChannelsFromDB(socket.id);
      const resumedGuestUser = users.get(socket.id);
      setSocketMeshPresenceConnectedAt(upsertPresenceLeaseForUser(resumedGuestUser, resumedGuestConnectedAt));
      socket.emit("init", {
        channels: guestChannels,
        users: buildDistributedUsersSnapshot(),
        voiceState: getVoiceStatePayload(),
        emotes: getEmotes(),
        roleDefinitions: getRoleDefinitions(),
        sessionId,
        messagePurgeVersion: getMessagePurgeVersion()
      });

      if (resumedGuestUser) {
        emitUserJoinedBroadcast(resumedGuestUser, 'join_guest_session_resume');
      }

      if (logEnabled) {
        log(`${session.username} re-joined the chat with a new socket`);
      }
      const rejoinedUser = users.get(socket.id);
      if (rejoinedUser) {
        emitUserJoinedHooks(rejoinedUser);
      }
      return;
    }

    const color = `#${Math.floor(Math.random()*16777215).toString(16)}`;
    const sessionId = generateSessionId();
    sessions.set(sessionId, {
      userId: socket.id,
      username,
      color,
      createdAt: Date.now()
    });

    const newGuestConnectedAt = Date.now();
    users.set(socket.id, {
      id: socket.id,
      username,
      color,
      status: 'active',
      profilePicture: undefined,
      joinedAt: newGuestConnectedAt
    } as TUser);

    const newGuestChannels = loadUserChannelsFromDB(socket.id);
    const newGuestUser = users.get(socket.id);
    setSocketMeshPresenceConnectedAt(upsertPresenceLeaseForUser(newGuestUser, newGuestConnectedAt));
    socket.emit("init", {
      channels: newGuestChannels,
      users: buildDistributedUsersSnapshot(),
      voiceState: getVoiceStatePayload(),
      emotes: getEmotes(),
      roleDefinitions: getRoleDefinitions(),
      sessionId,
      messagePurgeVersion: getMessagePurgeVersion()
    });

    if (newGuestUser) {
      emitUserJoinedBroadcast(newGuestUser, 'join_guest_new_session');
      emitUserJoinedHooks(newGuestUser);
    }

    if (logEnabled) {
      log(`${username} joined the chat as guest`);
    }
  });
}
