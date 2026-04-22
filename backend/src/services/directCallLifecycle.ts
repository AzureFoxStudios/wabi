interface AddCallPeerOptions {
  onLinked?: (socketIds: string[]) => void;
}

interface RemoveAllCallPeersOptions {
  onPeerRemoved?: (socketId: string) => void;
}

interface DirectCallActionResult {
  ok: boolean;
  code?: string;
  message?: string;
  targetUserId?: string;
}

interface CreateDirectCallLifecycleOptions {
  emitToCallTarget: (rawTargetId: string | null | undefined, event: string, data: unknown) => boolean;
  emitMeshBroadcast: (event: string, payload: unknown) => void;
  emitSocketBroadcast: (event: string, payload: unknown) => void;
  resolveStableUserIdFromAny: (rawId: string) => string | null;
  resolveSocketId: (stableUserId: string) => string | null;
  hasLocalSocket: (socketId: string) => boolean;
  isStableUserConnected: (stableUserId: string) => boolean;
  addCallPeer: (socketId: string, peerId: string, options?: AddCallPeerOptions) => void;
  removeAllCallPeers: (socketId: string, options?: RemoveAllCallPeersOptions) => Set<string>;
  addVoicePeerLink: (stableA: string, stableB: string) => void;
  removeVoicePeerLink: (stableA: string, stableB: string) => void;
  removeAllVoicePeerLinks: (stableId: string) => Set<string>;
  emitDirectCallRecordingPresenceForSocket: (socketId: string) => void;
  emitDirectCallRecordingPresenceForSocketSet: (socketIds: Iterable<string>) => void;
  clearAllRecordingPresenceForStableUser: (stableUserId: string, socketId?: string) => void;
}

export function createDirectCallLifecycle({
  emitToCallTarget,
  emitMeshBroadcast,
  emitSocketBroadcast,
  resolveStableUserIdFromAny,
  resolveSocketId,
  hasLocalSocket,
  isStableUserConnected,
  addCallPeer,
  removeAllCallPeers,
  addVoicePeerLink,
  removeVoicePeerLink,
  removeAllVoicePeerLinks,
  emitDirectCallRecordingPresenceForSocket,
  emitDirectCallRecordingPresenceForSocketSet,
  clearAllRecordingPresenceForStableUser
}: CreateDirectCallLifecycleOptions) {
  const teardownDirectCallState = ({
    socketId,
    stableUserId,
    participantIds
  }: {
    socketId: string;
    stableUserId: string;
    participantIds?: string[];
  }): Set<string> => {
    const callPeers = removeAllCallPeers(socketId, {
      onPeerRemoved: (peerId) => {
        emitDirectCallRecordingPresenceForSocket(peerId);
      }
    });

    clearAllRecordingPresenceForStableUser(stableUserId, socketId);
    emitDirectCallRecordingPresenceForSocketSet(callPeers);

    if (participantIds && participantIds.length > 0) {
      for (const participantId of participantIds) {
        const participantStableId = resolveStableUserIdFromAny(participantId) || participantId;
        removeVoicePeerLink(stableUserId, participantStableId);
      }
    } else {
      removeAllVoicePeerLinks(stableUserId);
    }

    return callPeers;
  };

  const initiateDirectCall = ({
    initiatorStableId,
    initiatorUsername,
    targetUserId,
    isVideoCall
  }: {
    initiatorStableId: string;
    initiatorUsername: string;
    targetUserId?: string;
    isVideoCall: boolean;
  }): DirectCallActionResult => {
    if (!targetUserId) {
      return { ok: false };
    }

    const targetStableId = resolveStableUserIdFromAny(targetUserId) || targetUserId;
    if (!isStableUserConnected(targetStableId)) {
      return {
        ok: false,
        code: "target_unavailable",
        message: "Target user is not currently connected",
        targetUserId: targetStableId
      };
    }

    if (targetStableId === initiatorStableId) {
      return {
        ok: false,
        code: "self_call",
        message: "You cannot call yourself",
        targetUserId: targetStableId
      };
    }

    emitToCallTarget(targetStableId, "call-incoming", {
      userId: initiatorStableId,
      username: initiatorUsername,
      isVideoCall
    });

    return { ok: true };
  };

  const answerDirectCall = ({
    socketId,
    responderStableId,
    responderUsername,
    callerId,
    isVideoCall
  }: {
    socketId: string;
    responderStableId: string;
    responderUsername: string;
    callerId?: string;
    isVideoCall: boolean;
  }): DirectCallActionResult => {
    if (!callerId) {
      return { ok: false };
    }

    const callerStableId = resolveStableUserIdFromAny(callerId) || callerId;
    const callerSocketId = resolveSocketId(callerStableId);
    const hasLocalCallerSocket = Boolean(callerSocketId && hasLocalSocket(callerSocketId));

    if (!isStableUserConnected(callerStableId) || (!hasLocalCallerSocket && !callerStableId.startsWith('user-'))) {
      return {
        ok: false,
        code: "caller_unavailable",
        message: "Caller disconnected before the call was answered",
        targetUserId: callerStableId
      };
    }

    emitToCallTarget(callerStableId, "call-accepted", {
      userId: responderStableId,
      username: responderUsername,
      isVideoCall
    });

    if (callerSocketId && hasLocalCallerSocket) {
      addCallPeer(socketId, callerSocketId, {
        onLinked: (socketIds) => {
          emitDirectCallRecordingPresenceForSocketSet(socketIds);
        }
      });
    }

    addVoicePeerLink(responderStableId, callerStableId);

    return { ok: true };
  };

  const rejectDirectCall = ({
    responderStableId,
    callerId
  }: {
    responderStableId: string;
    callerId?: string;
  }): boolean => {
    if (!callerId) return false;
    const callerStableId = resolveStableUserIdFromAny(callerId) || callerId;
    return emitToCallTarget(callerStableId, "call-rejected", {
      userId: responderStableId
    });
  };

  const cancelDirectCall = ({
    cancellerStableId,
    targetUserId
  }: {
    cancellerStableId: string;
    targetUserId?: string;
  }): boolean => {
    if (!targetUserId) return false;
    const targetStableId = resolveStableUserIdFromAny(targetUserId) || targetUserId;
    return emitToCallTarget(targetStableId, "call-cancelled", {
      userId: cancellerStableId
    });
  };

  const endDirectCall = ({
    socketId,
    stableUserId,
    participantIds
  }: {
    socketId: string;
    stableUserId: string;
    participantIds?: string[];
  }): Set<string> => {
    const callPeers = teardownDirectCallState({
      socketId,
      stableUserId,
      participantIds
    });

    if (participantIds && participantIds.length > 0) {
      for (const participantId of participantIds) {
        emitToCallTarget(participantId, "call-ended", {
          userId: stableUserId
        });
      }
      return callPeers;
    }

    emitSocketBroadcast("call-ended", {
      userId: stableUserId
    });
    emitMeshBroadcast("call-ended", {
      userId: stableUserId
    });
    return callPeers;
  };

  const teardownDirectCallsForDisconnect = ({
    socketId,
    stableUserId
  }: {
    socketId: string;
    stableUserId: string;
  }): Set<string> => {
    const callPeers = teardownDirectCallState({
      socketId,
      stableUserId
    });

    for (const peerId of callPeers) {
      emitToCallTarget(peerId, "call-ended", { userId: socketId });
    }

    return callPeers;
  };

  return {
    initiateDirectCall,
    answerDirectCall,
    rejectDirectCall,
    cancelDirectCall,
    endDirectCall,
    teardownDirectCallsForDisconnect
  };
}
