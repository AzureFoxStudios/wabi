interface UserLike {
  username: string;
}

interface CallSocketLike {
  id: string;
  emit(event: string, payload: unknown): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

interface CallResult {
  ok: boolean;
  code?: string;
  message?: string;
  targetUserId?: string;
}

interface RegisterCallSocketHandlersOptions<TUser extends UserLike> {
  socket: CallSocketLike;
  users: Map<string, TUser>;
  getSocketStableId: () => string;
  initiateGroupCall: (payload: {
    channelId: string;
    initiatorSocketId: string;
    initiatorStableId: string;
    initiatorUsername: string;
    isVideoCall: boolean;
  }) => CallResult;
  initiateDirectCall: (payload: {
    initiatorStableId: string;
    initiatorUsername: string;
    targetUserId?: string;
    isVideoCall: boolean;
  }) => CallResult;
  answerGroupCall: (payload: {
    channelId: string;
    responderStableId: string;
    responderUsername: string;
  }) => CallResult;
  answerDirectCall: (payload: {
    socketId: string;
    responderStableId: string;
    responderUsername: string;
    callerId?: string;
    isVideoCall: boolean;
  }) => CallResult;
  rejectGroupCall: (payload: { channelId: string; stableUserId: string }) => void;
  rejectDirectCall: (payload: { responderStableId: string; callerId?: string }) => void;
  cancelGroupCall: (payload: {
    channelId: string;
    cancellerSocketId: string;
    cancellerStableId: string;
  }) => void;
  cancelDirectCall: (payload: { cancellerStableId: string; targetUserId?: string }) => void;
  stopRingingForGroupCall: (payload: {
    channelId: string;
    requesterSocketId: string;
    requesterStableId: string;
    targetUserId: string;
  }) => void;
  leaveGroupCall: (payload: { channelId: string; stableUserId: string; socketId: string }) => void;
  endDirectCall: (payload: { socketId: string; stableUserId: string; participantIds?: string[] }) => void;
}

function emitCallError(socket: CallSocketLike, result: CallResult): void {
  if (!result.ok && result.code && result.message) {
    socket.emit("call-error", {
      code: result.code,
      message: result.message,
      targetUserId: result.targetUserId
    });
  }
}

export function registerCallSocketHandlers<TUser extends UserLike>({
  socket,
  users,
  getSocketStableId,
  initiateGroupCall,
  initiateDirectCall,
  answerGroupCall,
  answerDirectCall,
  rejectGroupCall,
  rejectDirectCall,
  cancelGroupCall,
  cancelDirectCall,
  stopRingingForGroupCall,
  leaveGroupCall,
  endDirectCall
}: RegisterCallSocketHandlersOptions<TUser>): void {
  socket.on("call-initiate", (data: { targetUserId?: string; channelId?: string; isVideoCall: boolean }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const myStableId = getSocketStableId();
    if (data.channelId) {
      emitCallError(socket, initiateGroupCall({
        channelId: data.channelId,
        initiatorSocketId: socket.id,
        initiatorStableId: myStableId,
        initiatorUsername: user.username,
        isVideoCall: data.isVideoCall
      }));
      return;
    }

    emitCallError(socket, initiateDirectCall({
      initiatorStableId: myStableId,
      initiatorUsername: user.username,
      targetUserId: data.targetUserId,
      isVideoCall: data.isVideoCall
    }));
  });

  socket.on("call-answer", (data: { callerId?: string; isVideoCall: boolean; channelId?: string }) => {
    const user = users.get(socket.id);
    if (data.channelId) {
      if (!user) return;
      emitCallError(socket, answerGroupCall({
        channelId: data.channelId,
        responderStableId: getSocketStableId(),
        responderUsername: user.username
      }));
      return;
    }

    emitCallError(socket, answerDirectCall({
      socketId: socket.id,
      responderStableId: getSocketStableId(),
      responderUsername: user?.username || 'Unknown',
      callerId: data.callerId,
      isVideoCall: data.isVideoCall
    }));
  });

  socket.on("call-reject", (data: { callerId?: string; channelId?: string }) => {
    if (data.channelId) {
      rejectGroupCall({
        channelId: data.channelId,
        stableUserId: getSocketStableId()
      });
      return;
    }

    rejectDirectCall({
      responderStableId: getSocketStableId(),
      callerId: data.callerId
    });
  });

  socket.on("call-cancel", (data: { targetUserId?: string; channelId?: string }) => {
    if (data.channelId) {
      cancelGroupCall({
        channelId: data.channelId,
        cancellerSocketId: socket.id,
        cancellerStableId: getSocketStableId()
      });
      return;
    }

    cancelDirectCall({
      cancellerStableId: getSocketStableId(),
      targetUserId: data.targetUserId
    });
  });

  socket.on("group-call-stop-ringing", (data: { channelId: string; targetUserId: string }) => {
    stopRingingForGroupCall({
      channelId: data.channelId,
      requesterSocketId: socket.id,
      requesterStableId: getSocketStableId(),
      targetUserId: data.targetUserId
    });
  });

  socket.on("group-call-leave", (data: { channelId: string }) => {
    leaveGroupCall({
      channelId: data.channelId,
      stableUserId: getSocketStableId(),
      socketId: socket.id
    });
  });

  socket.on("call-end", (data?: { participants?: string[] }) => {
    endDirectCall({
      socketId: socket.id,
      stableUserId: getSocketStableId(),
      participantIds: data?.participants
    });
  });
}
