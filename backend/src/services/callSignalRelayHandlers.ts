interface UserLike {
  username?: string;
}

interface ChannelLike {
  type?: string;
}

interface GroupCallSessionLike {
  connectedParticipants: Set<string>;
}

interface CallSignalSocketLike {
  id: string;
  emit(event: string, payload: unknown): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

interface RegisterCallSignalRelayHandlersOptions<TUser extends UserLike, TChannel extends ChannelLike> {
  socket: CallSignalSocketLike;
  users: Map<string, TUser>;
  channels: Map<string, TChannel>;
  groupCallSessions: Map<string, GroupCallSessionLike>;
  getVoiceAudienceSocketIds: (channelId: string) => Set<string>;
  getSocketStableId: () => string;
  resolveStableUserIdFromAny: (rawId: string) => string | null;
  resolveSocketId: (stableUserId: string) => string | null;
  emitToCallTarget: (rawTargetId: string | null | undefined, event: string, data: unknown) => boolean;
}

export function registerCallSignalRelayHandlers<TUser extends UserLike, TChannel extends ChannelLike>({
  socket,
  users,
  channels,
  groupCallSessions,
  getVoiceAudienceSocketIds,
  getSocketStableId,
  resolveStableUserIdFromAny,
  resolveSocketId,
  emitToCallTarget
}: RegisterCallSignalRelayHandlersOptions<TUser, TChannel>): void {
  socket.on("call-offer", (data: { offer: RTCSessionDescriptionInit; targetId: string; channelId?: string }) => {
    let targetSocketId = data.targetId;
    let targetStableId = resolveStableUserIdFromAny(data.targetId);

    if (data.channelId) {
      const channel = channels.get(data.channelId);
      if (!channel) return;

      if (channel.type === 'voice') {
        const audience = getVoiceAudienceSocketIds(data.channelId);
        if (!audience.has(socket.id) || !audience.has(data.targetId)) {
          return;
        }
      } else if (channel.type === 'group') {
        const session = groupCallSessions.get(data.channelId);
        const senderStableId = getSocketStableId();
        targetStableId = resolveStableUserIdFromAny(data.targetId);
        const resolvedTargetSocketId = users.has(data.targetId)
          ? data.targetId
          : (targetStableId ? resolveSocketId(targetStableId) : null);

        if (
          !session ||
          !targetStableId ||
          !resolvedTargetSocketId ||
          !users.has(resolvedTargetSocketId) ||
          !session.connectedParticipants.has(senderStableId) ||
          !session.connectedParticipants.has(targetStableId)
        ) {
          return;
        }

        targetSocketId = resolvedTargetSocketId;
      } else {
        return;
      }
    }

    const user = users.get(socket.id);
    const delivered = emitToCallTarget(targetStableId || targetSocketId, "call-offer", {
      offer: data.offer,
      senderId: getSocketStableId(),
      username: user?.username || 'Unknown',
      channelId: data.channelId
    });

    if (!delivered) {
      socket.emit("call-error", {
        code: "target_unavailable",
        message: "Target user is not currently connected",
        targetUserId: targetStableId || targetSocketId
      });
    }
  });

  socket.on("call-answer-sdp", (data: { answer: RTCSessionDescriptionInit; targetId: string }) => {
    emitToCallTarget(data.targetId, "call-answer-sdp", {
      answer: data.answer,
      senderId: getSocketStableId()
    });
  });

  socket.on("call-ice-candidate", (data: { candidate: RTCIceCandidateInit; targetId: string }) => {
    emitToCallTarget(data.targetId, "call-ice-candidate", {
      candidate: data.candidate,
      senderId: getSocketStableId()
    });
  });
}
