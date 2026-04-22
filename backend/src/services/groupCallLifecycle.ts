import type { GroupCallSession } from "./groupCallRuntime.js";

interface ChannelLike {
  id: string;
  name: string;
  type?: string;
  members?: string[];
}

interface GroupCallActionResult {
  ok: boolean;
  code?: string;
  message?: string;
  targetUserId?: string;
}

interface CreateGroupCallLifecycleOptions<TChannel extends ChannelLike> {
  groupCallSessions: Map<string, GroupCallSession>;
  getGroupChannelById: (channelId?: string) => TChannel | null;
  isStableUserConnected: (stableUserId: string) => boolean;
  resolveStableUserIdFromAny: (rawId: string) => string | null;
  emitToStableUser: (stableUserId: string, event: string, payload: unknown) => boolean;
  emitToSocketId: (socketId: string, event: string, payload: unknown) => void;
  isGroupCallEstablished: (session: GroupCallSession) => boolean;
  cancelPendingGroupCallInvites: (session: GroupCallSession, cancelledByUserId?: string) => void;
  cleanupIdleGroupCallSession: (
    session: GroupCallSession,
    options?: { cancelPending?: boolean; cancelledByUserId?: string }
  ) => boolean;
  emitGroupCallInviteCleared: (
    session: GroupCallSession,
    stableUserId: string,
    reason: "rejected" | "stopped" | "cancelled"
  ) => void;
  joinGroupCallSession: (
    session: GroupCallSession,
    stableUserId: string,
    username: string,
    options?: { onJoined?: (channelId: string) => void }
  ) => void;
  removeGroupCallParticipantFromSession: (
    session: GroupCallSession,
    stableUserId: string,
    options?: {
      userId?: string;
      cancelPendingIfEmpty?: boolean;
      cancelledByUserId?: string;
      onConnectedRemoved?: (channelId: string, stableUserId: string) => void;
    }
  ) => void;
  emitGroupCallRecordingPresence: (channelId: string) => void;
  removeRecorderFromGroupChannels: (stableUserId: string, channelId?: string) => void;
}

export function createGroupCallLifecycle<TChannel extends ChannelLike>({
  groupCallSessions,
  getGroupChannelById,
  isStableUserConnected,
  resolveStableUserIdFromAny,
  emitToStableUser,
  emitToSocketId,
  isGroupCallEstablished,
  cancelPendingGroupCallInvites,
  cleanupIdleGroupCallSession,
  emitGroupCallInviteCleared,
  joinGroupCallSession,
  removeGroupCallParticipantFromSession,
  emitGroupCallRecordingPresence,
  removeRecorderFromGroupChannels
}: CreateGroupCallLifecycleOptions<TChannel>) {
  const initiateGroupCall = ({
    channelId,
    initiatorSocketId,
    initiatorStableId,
    initiatorUsername,
    isVideoCall
  }: {
    channelId?: string;
    initiatorSocketId: string;
    initiatorStableId: string;
    initiatorUsername: string;
    isVideoCall: boolean;
  }): GroupCallActionResult => {
    const channel = getGroupChannelById(channelId);
    if (!channel) {
      return {
        ok: false,
        code: "invalid_channel",
        message: "Group channel not found",
        targetUserId: channelId
      };
    }

    if (!channel.members?.includes(initiatorStableId)) {
      return {
        ok: false,
        code: "not_group_member",
        message: "You are not a member of this group",
        targetUserId: channel.id
      };
    }

    let session = groupCallSessions.get(channel.id);
    if (!session) {
      session = {
        channelId: channel.id,
        channelName: channel.name,
        initiatorStableId,
        isVideoCall,
        hasEverEstablished: false,
        lastInviteSenderId: initiatorSocketId,
        invitedParticipants: new Set<string>(),
        connectedParticipants: new Set<string>()
      };
      groupCallSessions.set(channel.id, session);
    }

    session.channelName = channel.name;
    if (!isGroupCallEstablished(session)) {
      session.isVideoCall = isVideoCall;
    }
    if (session.connectedParticipants.size === 0) {
      session.initiatorStableId = initiatorStableId;
    }

    joinGroupCallSession(session, initiatorStableId, initiatorUsername, {
      onJoined: emitGroupCallRecordingPresence
    });

    const invitees = (channel.members || []).filter((memberStableId) => {
      if (memberStableId === initiatorStableId) return false;
      if (session.connectedParticipants.has(memberStableId)) return false;
      if (session.invitedParticipants.has(memberStableId)) return false;
      return isStableUserConnected(memberStableId);
    });

    if (invitees.length === 0 && session.connectedParticipants.size === 1 && session.invitedParticipants.size === 0) {
      groupCallSessions.delete(channel.id);
      return {
        ok: false,
        code: "target_unavailable",
        message: "No group members are currently connected",
        targetUserId: channel.id
      };
    }

    if (invitees.length > 0) {
      session.lastInviteSenderId = initiatorSocketId;
      for (const inviteeStableId of invitees) {
        session.invitedParticipants.add(inviteeStableId);
        emitToStableUser(inviteeStableId, "call-incoming", {
          userId: initiatorStableId,
          username: initiatorUsername,
          isVideoCall: session.isVideoCall,
          channelId: channel.id,
          channelName: channel.name
        });
      }
    }

    return { ok: true };
  };

  const answerGroupCall = ({
    channelId,
    responderStableId,
    responderUsername
  }: {
    channelId?: string;
    responderStableId: string;
    responderUsername: string;
  }): GroupCallActionResult => {
    const channel = getGroupChannelById(channelId);
    if (!channel) {
      return {
        ok: false,
        code: "invalid_channel",
        message: "Group channel not found",
        targetUserId: channelId
      };
    }

    if (!channel.members?.includes(responderStableId)) {
      return {
        ok: false,
        code: "not_group_member",
        message: "You are not a member of this group",
        targetUserId: channel.id
      };
    }

    const session = groupCallSessions.get(channel.id);
    if (!session) {
      return {
        ok: false,
        code: "caller_unavailable",
        message: "Group call is no longer available",
        targetUserId: channel.id
      };
    }

    session.channelName = channel.name;
    joinGroupCallSession(session, responderStableId, responderUsername, {
      onJoined: emitGroupCallRecordingPresence
    });

    return { ok: true };
  };

  const rejectGroupCall = ({
    channelId,
    stableUserId
  }: {
    channelId?: string;
    stableUserId: string;
  }): boolean => {
    if (!channelId) return false;
    const session = groupCallSessions.get(channelId);
    if (!session) return false;
    if (!session.invitedParticipants.has(stableUserId)) return false;

    session.invitedParticipants.delete(stableUserId);
    emitGroupCallInviteCleared(session, stableUserId, "rejected");
    cleanupIdleGroupCallSession(session);
    return true;
  };

  const cancelGroupCall = ({
    channelId,
    cancellerSocketId,
    cancellerStableId
  }: {
    channelId?: string;
    cancellerSocketId: string;
    cancellerStableId: string;
  }): boolean => {
    if (!channelId) return false;
    const session = groupCallSessions.get(channelId);
    if (!session) return false;
    if (!session.connectedParticipants.has(cancellerStableId)) return false;
    if (isGroupCallEstablished(session)) return false;

    cancelPendingGroupCallInvites(session, cancellerSocketId);
    session.connectedParticipants.delete(cancellerStableId);
    cleanupIdleGroupCallSession(session, {
      cancelPending: false,
      cancelledByUserId: cancellerSocketId
    });
    return true;
  };

  const stopRingingForGroupCall = ({
    channelId,
    requesterSocketId,
    requesterStableId,
    targetUserId
  }: {
    channelId: string;
    requesterSocketId: string;
    requesterStableId: string;
    targetUserId: string;
  }): boolean => {
    const session = groupCallSessions.get(channelId);
    if (!session || !targetUserId) return false;
    if (!session.connectedParticipants.has(requesterStableId)) return false;

    const targetStableId = resolveStableUserIdFromAny(targetUserId) || targetUserId;
    if (!session.invitedParticipants.has(targetStableId)) return false;

    session.invitedParticipants.delete(targetStableId);
    const targetSocketId = resolveSocketId(targetStableId);
    if (targetSocketId) {
      emitToSocketId(targetSocketId, "call-cancelled", {
        userId: requesterSocketId,
        channelId: session.channelId
      });
    }

    emitGroupCallInviteCleared(session, targetStableId, "stopped");
    cleanupIdleGroupCallSession(session);
    return true;
  };

  const leaveGroupCall = ({
    channelId,
    stableUserId,
    socketId
  }: {
    channelId: string;
    stableUserId: string;
    socketId: string;
  }): boolean => {
    const session = groupCallSessions.get(channelId);
    if (!session) return false;

    removeGroupCallParticipantFromSession(session, stableUserId, {
      userId: socketId,
      cancelPendingIfEmpty: true,
      onConnectedRemoved: (removedChannelId, removedStableUserId) => {
        removeRecorderFromGroupChannels(removedStableUserId, removedChannelId);
      }
    });
    return true;
  };

  return {
    initiateGroupCall,
    answerGroupCall,
    rejectGroupCall,
    cancelGroupCall,
    stopRingingForGroupCall,
    leaveGroupCall
  };
}
