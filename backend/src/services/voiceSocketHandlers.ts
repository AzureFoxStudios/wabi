interface UserLike {
  username?: string;
}

interface ChannelLike {
  type?: string;
}

interface RecordingActivationRequest {
  socketId: string;
  stableUserId: string;
  active: boolean;
  scope?: "direct" | "group" | "channel";
  channelId?: string;
}

interface VoiceSocketLike {
  id: string;
  emit(event: string, payload: unknown): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

interface RegisterVoiceSocketHandlersOptions<TUser extends UserLike, TChannel extends ChannelLike> {
  socket: VoiceSocketLike;
  users: Map<string, TUser>;
  channels: Map<string, TChannel>;
  voiceChannelParticipants: Map<string, Set<string>>;
  getSocketStableId: () => string;
  canAccessChannel: (channel: TChannel) => boolean;
  canJoinVoiceChannel: (
    channel: TChannel,
    stableUserId: string
  ) => { allowed: true } | { allowed: false; reason: string };
  canSubscribeToVoiceChannel: (
    socketId: string,
    channel: TChannel
  ) => { allowed: true } | { allowed: false; reason: string };
  addVoiceSubscription: (socketId: string, channelId: string) => void;
  removeVoiceSubscription: (socketId: string, channelId: string) => void;
  getVoiceChannelMembers: (channelId: string) => unknown[];
  emitVoiceChannelState: (channelId: string) => void;
  emitToVoiceAudience: (channelId: string, event: string, payload: unknown) => void;
  syncVoiceRecordingPresenceForSocket: (stableUserId: string, socketId: string) => void;
  emitVoiceChannelRecordingPresence: (channelId: string) => void;
  addVoicePeerLink: (stableA: string, stableB: string) => void;
  removeVoicePeerLink: (stableA: string, stableB: string) => void;
  removeAllVoicePeerLinks: (stableId: string) => Set<string>;
  setRecordingActiveForSocket: (
    request: RecordingActivationRequest
  ) => { ok: true } | { ok: false; error: string };
}

export function registerVoiceSocketHandlers<TUser extends UserLike, TChannel extends ChannelLike>({
  socket,
  users,
  channels,
  voiceChannelParticipants,
  getSocketStableId,
  canAccessChannel,
  canJoinVoiceChannel,
  canSubscribeToVoiceChannel,
  addVoiceSubscription,
  removeVoiceSubscription,
  getVoiceChannelMembers,
  emitVoiceChannelState,
  emitToVoiceAudience,
  syncVoiceRecordingPresenceForSocket,
  emitVoiceChannelRecordingPresence,
  addVoicePeerLink,
  removeVoicePeerLink,
  removeAllVoicePeerLinks,
  setRecordingActiveForSocket
}: RegisterVoiceSocketHandlersOptions<TUser, TChannel>): void {
  socket.on("voice-channel-join", (data: { channelId: string }) => {
    const user = users.get(socket.id);
    if (!user || !data.channelId) return;

    const voiceChannel = channels.get(data.channelId);
    if (!voiceChannel || voiceChannel.type !== 'voice') return;
    if (!canAccessChannel(voiceChannel)) return;

    const stableUserId = getSocketStableId();
    const voiceGate = canJoinVoiceChannel(voiceChannel, stableUserId);
    if (!voiceGate.allowed) {
      socket.emit("channel-error", voiceGate.reason);
      return;
    }

    let participants = voiceChannelParticipants.get(data.channelId);
    if (!participants) {
      participants = new Set<string>();
      voiceChannelParticipants.set(data.channelId, participants);
    }

    if (participants.has(stableUserId)) return;

    participants.add(stableUserId);
    addVoiceSubscription(socket.id, data.channelId);
    emitVoiceChannelState(data.channelId);
    syncVoiceRecordingPresenceForSocket(stableUserId, socket.id);
    emitVoiceChannelRecordingPresence(data.channelId);
    emitToVoiceAudience(data.channelId, "voice-channel-user-joined", {
      channelId: data.channelId,
      userId: stableUserId,
      socketId: socket.id,
      username: user.username || 'Unknown'
    });
  });

  socket.on("voice-channel-subscribe", (data: { channelId: string }) => {
    const user = users.get(socket.id);
    if (!user || !data.channelId) return;

    const voiceChannel = channels.get(data.channelId);
    if (!voiceChannel || voiceChannel.type !== 'voice') return;
    if (!canAccessChannel(voiceChannel)) return;

    const subscriptionGate = canSubscribeToVoiceChannel(socket.id, voiceChannel);
    if (!subscriptionGate.allowed) {
      socket.emit("channel-error", subscriptionGate.reason);
      return;
    }

    addVoiceSubscription(socket.id, data.channelId);
    socket.emit("voice-channel-subscribed", {
      channelId: data.channelId,
      members: getVoiceChannelMembers(data.channelId)
    });
    emitVoiceChannelState(data.channelId);
    syncVoiceRecordingPresenceForSocket(getSocketStableId(), socket.id);
    emitVoiceChannelRecordingPresence(data.channelId);
  });

  socket.on("voice-channel-leave", (data: { channelId: string }) => {
    const user = users.get(socket.id);
    if (!user || !data.channelId) return;

    const stableUserId = getSocketStableId();
    const participants = voiceChannelParticipants.get(data.channelId);
    if (!participants || !participants.has(stableUserId)) return;

    participants.delete(stableUserId);
    if (participants.size === 0) {
      voiceChannelParticipants.delete(data.channelId);
    }

    emitVoiceChannelState(data.channelId);
    emitToVoiceAudience(data.channelId, "voice-channel-user-left", {
      channelId: data.channelId,
      userId: stableUserId,
      socketId: socket.id
    });

    removeAllVoicePeerLinks(stableUserId);
    removeVoiceSubscription(socket.id, data.channelId);
    syncVoiceRecordingPresenceForSocket(stableUserId, socket.id);
  });

  socket.on("voice-channel-unsubscribe", (data: { channelId: string }) => {
    const user = users.get(socket.id);
    if (!user || !data.channelId) return;

    removeVoiceSubscription(socket.id, data.channelId);
    syncVoiceRecordingPresenceForSocket(getSocketStableId(), socket.id);
  });

  socket.on("voice-peer-link", (data: { peerStableUserId: string }) => {
    const user = users.get(socket.id);
    if (!user || !data.peerStableUserId) return;

    addVoicePeerLink(getSocketStableId(), data.peerStableUserId);
  });

  socket.on("voice-peer-unlink", (data: { peerStableUserId: string }) => {
    const user = users.get(socket.id);
    if (!user || !data.peerStableUserId) return;

    removeVoicePeerLink(getSocketStableId(), data.peerStableUserId);
  });

  socket.on(
    "call-recording-set-active",
    (
      data: { active: boolean; scope?: "direct" | "group" | "channel"; channelId?: string },
      callback?: (response: { ok: boolean; error?: string }) => void
    ) => {
      const user = users.get(socket.id);
      const respond = (ok: boolean, error?: string) => {
        if (typeof callback === 'function') {
          callback(ok ? { ok: true } : { ok: false, error });
        }
      };

      if (!user || typeof data?.active !== 'boolean') {
        respond(false, 'Invalid recording state payload.');
        return;
      }

      const stableUserId = getSocketStableId();
      const result = setRecordingActiveForSocket({
        socketId: socket.id,
        stableUserId,
        active: data.active,
        scope: data.scope,
        channelId: data.channelId
      });
      respond(result.ok, result.ok ? undefined : result.error);
    }
  );
}
