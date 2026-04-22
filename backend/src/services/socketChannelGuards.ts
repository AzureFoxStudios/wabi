interface SocketLike {
  id: string;
  emit(event: string, payload: unknown): boolean;
}

interface ActiveUserLike {
  highestRole?: string;
}

interface ChannelLike {
  members?: string[] | null;
  minRole?: string;
}

interface CreateSocketChannelGuardsOptions<TSocket extends SocketLike, TChannel extends ChannelLike> {
  socket: TSocket;
  users: Map<string, ActiveUserLike>;
  channels: Map<string, TChannel>;
  getStableUserId: (socket: TSocket) => string;
  getRolePriority: (roleName: string) => number;
  findUserByStableId: (stableUserId: string) => { highestRole?: string } | undefined;
}

export function createSocketChannelGuards<TSocket extends SocketLike, TChannel extends ChannelLike>({
  socket,
  users,
  channels,
  getStableUserId,
  getRolePriority,
  findUserByStableId
}: CreateSocketChannelGuardsOptions<TSocket, TChannel>) {
  const getSocketStableId = (): string => getStableUserId(socket);

  const getSocketHighestRole = (): string => {
    const user = users.get(socket.id);
    return user?.highestRole || 'guest';
  };

  const socketMeetsRoleRequirement = (minRole?: string): boolean => {
    const requiredRole = minRole || 'guest';
    if (requiredRole === 'guest') return true;
    const myPriority = getRolePriority(getSocketHighestRole());
    const requiredPriority = getRolePriority(requiredRole);
    return myPriority >= requiredPriority;
  };

  const canManageVoiceBreakouts = (): boolean => {
    const highestRole = getSocketHighestRole();
    return ['owner', 'admin', 'mod'].includes(highestRole);
  };

  const canMoveVoiceMember = (targetStableUserId: string): boolean => {
    const myStableId = getSocketStableId();
    if (targetStableUserId === myStableId) {
      return true;
    }

    if (!canManageVoiceBreakouts()) {
      return false;
    }

    const myPriority = getRolePriority(getSocketHighestRole());
    const targetHighestRole = findUserByStableId(targetStableUserId)?.highestRole || 'guest';
    const targetPriority = getRolePriority(targetHighestRole);
    return myPriority > targetPriority;
  };

  const canAccessChannel = (channel: TChannel): boolean => {
    if (!channel.members || channel.members.length === 0) {
      return socketMeetsRoleRequirement(channel.minRole);
    }
    return channel.members.includes(getSocketStableId());
  };

  const getAccessibleChannel = (channelId: string): TChannel | null => {
    const channel = channels.get(channelId);
    if (!channel) {
      socket.emit("channel-error", `Channel ${channelId} does not exist`);
      return null;
    }
    if (!canAccessChannel(channel)) {
      socket.emit("channel-error", "Access denied to this channel");
      return null;
    }
    return channel;
  };

  return {
    getSocketStableId,
    getSocketHighestRole,
    socketMeetsRoleRequirement,
    canManageVoiceBreakouts,
    canMoveVoiceMember,
    canAccessChannel,
    getAccessibleChannel
  };
}
