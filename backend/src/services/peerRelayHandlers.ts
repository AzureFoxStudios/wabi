interface UserLike {
  id: string;
  username?: string;
  dbUserId?: number;
}

interface ChannelLike {
  members?: string[];
}

interface ScreenSharerLike {
  userId: string;
  username: string;
}

interface PeerRelaySocketLike {
  id: string;
  emit(event: string, payload: unknown): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

interface RegisterPeerRelayHandlersOptions<TUser extends UserLike, TChannel extends ChannelLike> {
  socket: PeerRelaySocketLike;
  users: Map<string, TUser>;
  channels: Map<string, TChannel>;
  screenSharers: Map<string, ScreenSharerLike>;
  getSocketStableId: () => string;
  getPublicUserId: (user: Pick<TUser, 'id' | 'dbUserId'>) => string;
  findUserByStableId: (stableUserId: string) => TUser | undefined;
  emitSocketBroadcast: (event: string, payload: unknown) => void;
  emitToSocketId: (socketId: string, event: string, payload: unknown) => void;
}

export function registerPeerRelayHandlers<TUser extends UserLike, TChannel extends ChannelLike>({
  socket,
  users,
  channels,
  screenSharers,
  getSocketStableId,
  getPublicUserId,
  findUserByStableId,
  emitSocketBroadcast,
  emitToSocketId
}: RegisterPeerRelayHandlersOptions<TUser, TChannel>): void {
  const senderSharesChannelWith = (targetUser: TUser): boolean => {
    const senderStableId = getSocketStableId();
    const targetStableId = getPublicUserId(targetUser);
    if (!senderStableId || !targetStableId) return false;

    return Array.from(channels.values()).some((channel) => {
      if (!channel.members || channel.members.length === 0) return true;
      return channel.members.includes(senderStableId) && channel.members.includes(targetStableId);
    });
  };

  socket.on("start-screen-share", () => {
    const user = users.get(socket.id);
    if (!user) return;

    screenSharers.set(socket.id, {
      userId: socket.id,
      username: user.username || 'Unknown'
    });

    emitSocketBroadcast("screen-share-started", {
      userId: socket.id,
      username: user.username || 'Unknown'
    });
  });

  socket.on("stop-screen-share", () => {
    screenSharers.delete(socket.id);
    emitSocketBroadcast("screen-share-stopped", { userId: socket.id });
  });

  socket.on("request-screen-share", (data: { sharerId: string }) => {
    emitToSocketId(data.sharerId, "screen-share-request", { viewerId: socket.id });
  });

  socket.on("webrtc-offer", (data: { offer: RTCSessionDescriptionInit; targetId: string }) => {
    const user = users.get(socket.id);
    const targetUser = users.get(data.targetId) || findUserByStableId(data.targetId);
    if (!targetUser) return;
    if (!senderSharesChannelWith(targetUser)) return;

    emitToSocketId(data.targetId, "webrtc-offer", {
      offer: data.offer,
      senderId: socket.id,
      username: user?.username || 'Unknown'
    });
  });

  socket.on("webrtc-answer", (data: { answer: RTCSessionDescriptionInit; targetId: string }) => {
    const targetUser = users.get(data.targetId) || findUserByStableId(data.targetId);
    if (!targetUser) return;
    if (!senderSharesChannelWith(targetUser)) return;

    emitToSocketId(data.targetId, "webrtc-answer", {
      answer: data.answer,
      senderId: socket.id
    });
  });

  socket.on("webrtc-ice-candidate", (data: { candidate: RTCIceCandidateInit; targetId: string }) => {
    const targetUser = users.get(data.targetId) || findUserByStableId(data.targetId);
    if (!targetUser) return;
    if (!senderSharesChannelWith(targetUser)) return;

    emitToSocketId(data.targetId, "webrtc-ice-candidate", {
      candidate: data.candidate,
      senderId: socket.id
    });
  });

  socket.on("p2p-offer", (data: { transferId: string; targetId: string; offer: any; fileName: string; fileSize: number }) => {
    const user = users.get(socket.id);
    emitToSocketId(data.targetId, "p2p-offer", {
      transferId: data.transferId,
      senderId: socket.id,
      senderUsername: user?.username || 'Unknown',
      offer: data.offer,
      fileName: data.fileName,
      fileSize: data.fileSize
    });
  });

  socket.on("p2p-answer", (data: { transferId: string; targetId: string; answer: any }) => {
    emitToSocketId(data.targetId, "p2p-answer", {
      transferId: data.transferId,
      senderId: socket.id,
      answer: data.answer
    });
  });

  socket.on("p2p-ice-candidate", (data: { transferId: string; targetId: string; candidate: any }) => {
    emitToSocketId(data.targetId, "p2p-ice-candidate", {
      transferId: data.transferId,
      senderId: socket.id,
      candidate: data.candidate
    });
  });
}
