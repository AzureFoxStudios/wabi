interface UserLike {
  username: string;
  dbUserId?: number;
  joinedAt?: number | null;
}

interface GroupCallSessionLike {
  connectedParticipants: Set<string>;
  invitedParticipants: Set<string>;
}

interface DisconnectSocketLike {
  id: string;
  emit(event: string, payload: unknown): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  broadcast: {
    emit(event: string, payload: unknown): boolean;
  };
}

interface RegisterDisconnectCleanupHandlerOptions<TUser extends UserLike, TGroupCallSession extends GroupCallSessionLike> {
  socket: DisconnectSocketLike;
  users: Map<string, TUser>;
  dbUserIdToSocketId: Map<number, string>;
  typingUsers: Set<string>;
  userCurrentChannel: Map<string, string>;
  channelTypingUsers: Map<string, Set<string>>;
  screenSharers: Map<string, unknown>;
  groupCallSessions: Map<string, TGroupCallSession>;
  voiceChannelParticipants: Map<string, Set<string>>;
  getSocketStableId: () => string;
  getSocketMeshLeaseConnectedAt: () => unknown;
  getSocketMeshPresenceConnectedAt: () => unknown;
  recordPresenceStateEvent: (reason: string) => void;
  releaseStateMeshSocketLease: (stableUserId: string, connectedAt: unknown) => void;
  deletePresenceLeaseForUser: (user: TUser, connectedAt: unknown) => void;
  teardownDirectCallsForDisconnect: (payload: { socketId: string; stableUserId: string }) => void;
  removeGroupCallParticipantFromSession: (
    session: TGroupCallSession,
    stableUserId: string,
    options: {
      userId: string;
      cancelPendingIfEmpty: boolean;
      onConnectedRemoved: (channelId: string, removedStableUserId: string) => void;
    }
  ) => void;
  removeRecorderFromGroupChannels: (stableUserId: string, channelId?: string) => void;
  emitVoiceChannelState: (channelId: string) => void;
  emitToVoiceAudience: (channelId: string, event: string, payload: unknown) => void;
  removeAllVoicePeerLinks: (stableUserId: string) => void;
  removeAllVoiceSubscriptionsForSocket: (socketId: string) => void;
  getPublicUserId: (user: TUser) => string;
  emitMeshBroadcast: (event: string, payload: unknown) => void;
  triggerOnUserLeave: (socketId: string) => Promise<void>;
  dispatchUserLeftWebhook: (payload: { id: string; username: string; dbUserId: number | null }) => Promise<void>;
  logEnabled: boolean;
  log: (...args: unknown[]) => void;
}

export function registerDisconnectCleanupHandler<
  TUser extends UserLike,
  TGroupCallSession extends GroupCallSessionLike
>({
  socket,
  users,
  dbUserIdToSocketId,
  typingUsers,
  userCurrentChannel,
  channelTypingUsers,
  screenSharers,
  groupCallSessions,
  voiceChannelParticipants,
  getSocketStableId,
  getSocketMeshLeaseConnectedAt,
  getSocketMeshPresenceConnectedAt,
  recordPresenceStateEvent,
  releaseStateMeshSocketLease,
  deletePresenceLeaseForUser,
  teardownDirectCallsForDisconnect,
  removeGroupCallParticipantFromSession,
  removeRecorderFromGroupChannels,
  emitVoiceChannelState,
  emitToVoiceAudience,
  removeAllVoicePeerLinks,
  removeAllVoiceSubscriptionsForSocket,
  getPublicUserId,
  emitMeshBroadcast,
  triggerOnUserLeave,
  dispatchUserLeftWebhook,
  logEnabled,
  log
}: RegisterDisconnectCleanupHandlerOptions<TUser, TGroupCallSession>): void {
  socket.on("disconnect", () => {
    const user = users.get(socket.id);
    if (!user) return;

    recordPresenceStateEvent('disconnect');

    if (user.dbUserId) {
      const currentSocketForUser = dbUserIdToSocketId.get(user.dbUserId);
      if (currentSocketForUser === socket.id) {
        dbUserIdToSocketId.delete(user.dbUserId);
      }
      releaseStateMeshSocketLease(`user-${user.dbUserId}`, getSocketMeshLeaseConnectedAt() ?? null);
    }
    deletePresenceLeaseForUser(user, getSocketMeshPresenceConnectedAt() ?? null);

    users.delete(socket.id);
    typingUsers.delete(socket.id);

    const channelId = userCurrentChannel.get(socket.id);
    if (channelId) {
      const channelTyping = channelTypingUsers.get(channelId);
      if (channelTyping) {
        channelTyping.delete(socket.id);
      }
      userCurrentChannel.delete(socket.id);
    }

    if (screenSharers.has(socket.id)) {
      screenSharers.delete(socket.id);
      socket.broadcast.emit("screen-share-stopped", { userId: socket.id });
    }

    const stableUserId = getSocketStableId();
    teardownDirectCallsForDisconnect({
      socketId: socket.id,
      stableUserId
    });

    for (const session of Array.from(groupCallSessions.values())) {
      if (!session.connectedParticipants.has(stableUserId) && !session.invitedParticipants.has(stableUserId)) {
        continue;
      }

      removeGroupCallParticipantFromSession(session, stableUserId, {
        userId: socket.id,
        cancelPendingIfEmpty: true,
        onConnectedRemoved: (removedChannelId, removedStableUserId) => {
          removeRecorderFromGroupChannels(removedStableUserId, removedChannelId);
        }
      });
    }

    for (const [voiceChannelId, participants] of voiceChannelParticipants.entries()) {
      if (!participants.has(stableUserId)) continue;

      participants.delete(stableUserId);
      if (participants.size === 0) {
        voiceChannelParticipants.delete(voiceChannelId);
      }

      emitVoiceChannelState(voiceChannelId);
      emitToVoiceAudience(voiceChannelId, "voice-channel-user-left", {
        channelId: voiceChannelId,
        userId: stableUserId,
        socketId: socket.id
      });
    }

    removeAllVoicePeerLinks(stableUserId);
    removeAllVoiceSubscriptionsForSocket(socket.id);

    const leftPayload = {
      id: getPublicUserId(user),
      username: user.username,
      dbUserId: user.dbUserId,
      joinedAt: user.joinedAt ?? (getSocketMeshPresenceConnectedAt() ?? null)
    };
    socket.broadcast.emit("user-left", leftPayload);
    emitMeshBroadcast("user-left", leftPayload);

    triggerOnUserLeave(socket.id).catch((error) => {
      console.error('[Plugins] Failed to trigger onUserLeave hook:', error);
    });
    dispatchUserLeftWebhook({
      id: socket.id,
      username: user.username,
      dbUserId: user.dbUserId || null
    }).catch((error) => {
      console.error('[Webhooks] Failed to dispatch user.left:', error);
    });

    if (logEnabled) {
      log(`${user.username} left the chat`);
    }
  });
}
