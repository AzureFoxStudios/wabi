interface BreakoutChannelLike {
  id: string;
  name: string;
  description?: string;
  minRole?: string;
  createdAt: number;
  type?: string;
  parentChannelId?: string;
  isBreakout?: boolean;
  breakoutIndex?: number;
  persistMessages?: boolean;
}

interface VoiceMoveMemberLike {
  socketId: string;
}

interface VoiceBreakoutSocketLike {
  emit(event: string, payload: unknown): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

interface RegisterVoiceBreakoutHandlersOptions<TChannel extends BreakoutChannelLike> {
  socket: VoiceBreakoutSocketLike;
  channels: Map<string, TChannel>;
  channelMessages: Map<string, unknown[]>;
  pinnedMessages: Map<string, Set<string>>;
  voiceChannelParticipants: Map<string, Set<string>>;
  getSocketStableId: () => string;
  canAccessChannel: (channel: TChannel) => boolean;
  canManageVoiceBreakouts: () => boolean;
  canMoveVoiceMember: (stableUserId: string) => boolean;
  getBreakoutChannelsForParent: (parentChannelId: string) => TChannel[];
  resolveStableUserIdFromAny: (rawId: string) => string | null;
  canJoinVoiceChannel: (
    channel: TChannel,
    stableUserId: string
  ) => { allowed: true } | { allowed: false; reason: string };
  moveVoiceParticipant: (
    stableUserId: string,
    fromChannelId: string,
    toChannelId: string,
    options?: {
      onMoved?: (payload: {
        stableUserId: string;
        member: VoiceMoveMemberLike;
        fromChannelId: string;
        toChannelId: string;
      }) => void;
    }
  ) => boolean;
  syncVoiceRecordingPresenceForSocket: (stableUserId: string, socketId: string) => void;
  emitVoiceChannelRecordingPresence: (channelId: string) => void;
  emitVoiceChannelState: (channelId: string) => void;
  emitGlobalEvent: (event: string, payload: unknown) => void;
  emitVoiceBreakoutsUpdated: (payload: { parentChannelId: string; breakoutChannelIds: string[] }) => void;
  buildBreakoutChannel: (payload: {
    id: string;
    name: string;
    description: string;
    minRole: string;
    createdAt: number;
    parentChannelId: string;
    breakoutIndex: number;
  }) => TChannel;
  persistBreakoutChannel: (channel: TChannel, creatorStableId: string) => void;
  deletePersistedChannel: (channelId: string) => void;
}

export function registerVoiceBreakoutHandlers<TChannel extends BreakoutChannelLike>({
  socket,
  channels,
  channelMessages,
  pinnedMessages,
  voiceChannelParticipants,
  getSocketStableId,
  canAccessChannel,
  canManageVoiceBreakouts,
  canMoveVoiceMember,
  getBreakoutChannelsForParent,
  resolveStableUserIdFromAny,
  canJoinVoiceChannel,
  moveVoiceParticipant,
  syncVoiceRecordingPresenceForSocket,
  emitVoiceChannelRecordingPresence,
  emitVoiceChannelState,
  emitGlobalEvent,
  emitVoiceBreakoutsUpdated,
  buildBreakoutChannel,
  persistBreakoutChannel,
  deletePersistedChannel
}: RegisterVoiceBreakoutHandlersOptions<TChannel>): void {
  const handleVoiceMove = (stableUserId: string, fromChannelId: string, toChannelId: string): void => {
    moveVoiceParticipant(stableUserId, fromChannelId, toChannelId, {
      onMoved: ({ stableUserId: movedStableUserId, fromChannelId: movedFromChannelId, toChannelId: movedToChannelId, member }) => {
        syncVoiceRecordingPresenceForSocket(movedStableUserId, member.socketId);
        emitVoiceChannelRecordingPresence(movedFromChannelId);
        emitVoiceChannelRecordingPresence(movedToChannelId);
      }
    });
  };

  socket.on("create-breakout-rooms", (data: { parentChannelId: string; roomCount?: number; autoAssign?: boolean }) => {
    const parentChannel = channels.get(data.parentChannelId);
    if (!parentChannel || parentChannel.type !== 'voice' || parentChannel.isBreakout) {
      socket.emit("channel-error", "Breakout rooms require a parent voice channel");
      return;
    }
    if (!canAccessChannel(parentChannel)) {
      socket.emit("channel-error", "Access denied to this voice channel");
      return;
    }
    if (!canManageVoiceBreakouts()) {
      socket.emit("channel-error", "Only owner/admin/mod can manage breakout rooms");
      return;
    }

    const existingBreakouts = getBreakoutChannelsForParent(parentChannel.id);
    if (existingBreakouts.length > 0) {
      socket.emit("channel-error", "Close existing breakout rooms before creating a new set");
      return;
    }

    const roomCount = Math.max(2, Math.min(20, Math.floor(data.roomCount || 2)));
    const createdRooms: TChannel[] = [];
    const creatorStableId = getSocketStableId();

    for (let i = 0; i < roomCount; i += 1) {
      const index = i + 1;
      let channelId = `${parentChannel.id}-breakout-${index}`;
      let suffix = 1;
      while (channels.has(channelId)) {
        suffix += 1;
        channelId = `${parentChannel.id}-breakout-${index}-${suffix}`;
      }

      const breakoutChannel = buildBreakoutChannel({
        id: channelId,
        name: `${parentChannel.name} Room ${index}`,
        description: `Breakout room ${index} for ${parentChannel.name}`,
        minRole: parentChannel.minRole || 'guest',
        createdAt: Date.now(),
        parentChannelId: parentChannel.id,
        breakoutIndex: index
      });

      channels.set(channelId, breakoutChannel);
      channelMessages.set(channelId, []);
      pinnedMessages.set(channelId, new Set());
      persistBreakoutChannel(breakoutChannel, creatorStableId);

      createdRooms.push(breakoutChannel);
      emitGlobalEvent("channel-created", breakoutChannel);
    }

    if (data.autoAssign !== false && createdRooms.length > 0) {
      const parentParticipants = Array.from(voiceChannelParticipants.get(parentChannel.id) || []);
      parentParticipants.forEach((stableUserId, idx) => {
        const targetRoom = createdRooms[idx % createdRooms.length];
        handleVoiceMove(stableUserId, parentChannel.id, targetRoom.id);
      });
    }

    emitVoiceBreakoutsUpdated({
      parentChannelId: parentChannel.id,
      breakoutChannelIds: createdRooms.map((room) => room.id)
    });
  });

  socket.on("close-breakout-rooms", (data: { parentChannelId: string }) => {
    const parentChannel = channels.get(data.parentChannelId);
    if (!parentChannel || parentChannel.type !== 'voice' || parentChannel.isBreakout) {
      socket.emit("channel-error", "Breakout parent voice channel not found");
      return;
    }
    if (!canAccessChannel(parentChannel)) {
      socket.emit("channel-error", "Access denied to this voice channel");
      return;
    }
    if (!canManageVoiceBreakouts()) {
      socket.emit("channel-error", "Only owner/admin/mod can manage breakout rooms");
      return;
    }

    const breakoutChannels = getBreakoutChannelsForParent(parentChannel.id);
    if (breakoutChannels.length === 0) return;

    breakoutChannels.forEach((breakoutChannel) => {
      const participants = Array.from(voiceChannelParticipants.get(breakoutChannel.id) || []);
      participants.forEach((stableUserId) => {
        handleVoiceMove(stableUserId, breakoutChannel.id, parentChannel.id);
      });

      voiceChannelParticipants.delete(breakoutChannel.id);
      channels.delete(breakoutChannel.id);
      channelMessages.delete(breakoutChannel.id);
      pinnedMessages.delete(breakoutChannel.id);
      deletePersistedChannel(breakoutChannel.id);
      emitGlobalEvent("channel-deleted", breakoutChannel.id);
    });

    emitVoiceChannelState(parentChannel.id);
    emitVoiceBreakoutsUpdated({
      parentChannelId: parentChannel.id,
      breakoutChannelIds: []
    });
  });

  socket.on("move-user-to-breakout", (data: { parentChannelId: string; targetUserId: string; toChannelId: string }) => {
    const parentChannel = channels.get(data.parentChannelId);
    if (!parentChannel || parentChannel.type !== 'voice') {
      socket.emit("channel-error", "Breakout parent voice channel not found");
      return;
    }
    if (!canAccessChannel(parentChannel)) {
      socket.emit("channel-error", "Access denied to this voice channel");
      return;
    }
    if (!canManageVoiceBreakouts()) {
      socket.emit("channel-error", "Only owner/admin/mod can move users between breakout rooms");
      return;
    }

    const targetChannel = channels.get(data.toChannelId);
    if (!targetChannel || targetChannel.type !== 'voice') {
      socket.emit("channel-error", "Target breakout channel not found");
      return;
    }
    if (targetChannel.id !== parentChannel.id && targetChannel.parentChannelId !== parentChannel.id) {
      socket.emit("channel-error", "Target channel is not part of this breakout set");
      return;
    }

    const stableUserId = resolveStableUserIdFromAny(data.targetUserId);
    if (!stableUserId) {
      socket.emit("channel-error", "Target user not found");
      return;
    }

    const familyChannels = [parentChannel, ...getBreakoutChannelsForParent(parentChannel.id)];
    const fromChannel = familyChannels.find((channel) => {
      const participants = voiceChannelParticipants.get(channel.id);
      return participants?.has(stableUserId);
    });
    if (!fromChannel) {
      socket.emit("channel-error", "Target user is not connected to this voice channel set");
      return;
    }

    const voiceGate = canJoinVoiceChannel(targetChannel, stableUserId);
    if (!voiceGate.allowed) {
      socket.emit("channel-error", voiceGate.reason);
      return;
    }

    handleVoiceMove(stableUserId, fromChannel.id, targetChannel.id);
  });

  socket.on("move-user-to-voice-channel", (data: { targetUserId: string; toChannelId: string }) => {
    const targetChannel = channels.get(data.toChannelId);
    if (!targetChannel || targetChannel.type !== 'voice') {
      socket.emit("channel-error", "Target voice channel not found");
      return;
    }
    if (!canAccessChannel(targetChannel)) {
      socket.emit("channel-error", "Access denied to this voice channel");
      return;
    }

    const stableUserId = resolveStableUserIdFromAny(data.targetUserId);
    if (!stableUserId) {
      socket.emit("channel-error", "Target user not found");
      return;
    }
    if (!canMoveVoiceMember(stableUserId)) {
      socket.emit("channel-error", "Only owner/admin/mod can move that user");
      return;
    }

    const voiceGate = canJoinVoiceChannel(targetChannel, stableUserId);
    if (!voiceGate.allowed) {
      socket.emit("channel-error", voiceGate.reason);
      return;
    }

    const fromChannel = Array.from(channels.values()).find((channel) => {
      if (channel.type !== 'voice') return false;
      const participants = voiceChannelParticipants.get(channel.id);
      return participants?.has(stableUserId);
    });
    if (!fromChannel) {
      socket.emit("channel-error", "Target user is not connected to a voice channel");
      return;
    }
    if (!canAccessChannel(fromChannel)) {
      socket.emit("channel-error", "Access denied to this voice channel");
      return;
    }

    handleVoiceMove(stableUserId, fromChannel.id, targetChannel.id);
  });
}
