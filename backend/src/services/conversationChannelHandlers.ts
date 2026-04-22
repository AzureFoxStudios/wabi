import { DEFAULT_DM_RETENTION, type MessageRetentionDuration } from "../../../shared/messageRetention.js";

interface UserLike {
  id: string;
  username: string;
  color?: string | null;
  status?: string | null;
  profilePicture?: string | null;
  dbUserId?: number;
}

interface ChannelLike {
  id: string;
  name: string;
  createdAt: number;
  type?: 'text' | 'voice' | 'dm' | 'group' | 'public' | 'thread_public' | 'thread_private';
  members?: string[];
  autoDeleteAfter?: MessageRetentionDuration | null;
  persistMessages?: boolean;
  recipientNotified?: boolean;
}

interface ConversationUserSummary {
  id: string;
  username: string;
  color?: string | null;
  status?: string | null;
  profilePicture?: string | null;
  dbUserId?: number;
}

interface GroupCreatedPayload {
  id: string;
  name: string;
  createdAt: number;
  type: 'group';
  members: string[];
  memberUsers: ConversationUserSummary[];
  autoDeleteAfter?: MessageRetentionDuration | null;
  persistMessages?: boolean;
  avatar: string | null;
}

interface GroupMemberRecord {
  channel_id: string;
  user_id: string;
  username: string;
  registered_user_id?: number;
  joined_at: number;
  role: 'owner' | 'admin' | 'member';
}

interface GroupMemberState {
  role?: 'owner' | 'admin' | 'member';
}

interface ConversationSocketLike {
  id: string;
  emit(event: string, payload: unknown): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

interface RegisterConversationChannelHandlersOptions<TUser extends UserLike, TChannel extends ChannelLike, TMessage> {
  socket: ConversationSocketLike;
  users: Map<string, TUser>;
  channels: Map<string, TChannel>;
  channelMessages: Map<string, TMessage[]>;
  pinnedMessages: Map<string, Set<string>>;
  getSocketStableId: () => string;
  resolveSocketId: (stableUserId: string) => string | null;
  emitToStableUser: (stableUserId: string, event: string, payload: unknown) => boolean;
  emitGroupCreatedSideEffects: (payload: GroupCreatedPayload) => void;
  buildOnlineUserSummary: (user: TUser) => ConversationUserSummary;
  buildOfflineRegisteredUserSummary: (stableUserId: string) => ConversationUserSummary | null;
  loadPersistedDmChannel: (channelId: string) => { channel: TChannel; messages: TMessage[] } | null;
  dmChannelExists: (channelId: string) => boolean;
  createPersistedDm: (payload: {
    channelId: string;
    name: string;
    createdAt: number;
    createdBy: string;
    myMember: {
      userId: string;
      username: string;
      registeredUserId?: number;
      joinedAt: number;
    };
    targetMember: {
      userId: string;
      username: string;
      registeredUserId?: number;
      joinedAt: number;
    };
  }) => void;
  deletePersistedChannel: (channelId: string) => void;
  createPersistedGroup: (payload: {
    channelId: string;
    name: string;
    createdAt: number;
    createdBy: string;
    members: GroupMemberRecord[];
  }) => void;
  removePersistedGroupMember: (channelId: string, stableUserId: string) => void;
  archivePersistedChannel: (channelId: string) => void;
  getPersistedGroupMember: (channelId: string, stableUserId: string) => GroupMemberState | null;
  addPersistedGroupMember: (payload: GroupMemberRecord) => void;
  getPersistedGroupAvatar: (channelId: string) => string | null;
  updatePersistedGroupAvatar: (channelId: string, avatarUrl: string | null) => void;
  logEnabled: boolean;
  log: (...args: unknown[]) => void;
}

export function registerConversationChannelHandlers<TUser extends UserLike, TChannel extends ChannelLike, TMessage>({
  socket,
  users,
  channels,
  channelMessages,
  pinnedMessages,
  getSocketStableId,
  resolveSocketId,
  emitToStableUser,
  emitGroupCreatedSideEffects,
  buildOnlineUserSummary,
  buildOfflineRegisteredUserSummary,
  loadPersistedDmChannel,
  dmChannelExists,
  createPersistedDm,
  deletePersistedChannel,
  createPersistedGroup,
  removePersistedGroupMember,
  archivePersistedChannel,
  getPersistedGroupMember,
  addPersistedGroupMember,
  getPersistedGroupAvatar,
  updatePersistedGroupAvatar,
  logEnabled,
  log
}: RegisterConversationChannelHandlersOptions<TUser, TChannel, TMessage>): void {
  const buildStableUserSummary = (stableId: string): ConversationUserSummary | null => {
    const socketId = resolveSocketId(stableId);
    const onlineUser = socketId ? users.get(socketId) : null;
    if (onlineUser) {
      return buildOnlineUserSummary(onlineUser);
    }
    return buildOfflineRegisteredUserSummary(stableId);
  };

  socket.on("create-dm", (data: { targetUserId: string }) => {
    const user = users.get(socket.id);
    if (!user) {
      socket.emit("channel-error", "User not found");
      return;
    }

    const myStableId = getSocketStableId();
    const onlineTargetUser = users.get(data.targetUserId);
    const targetStableId =
      onlineTargetUser
        ? (onlineTargetUser.dbUserId ? `user-${onlineTargetUser.dbUserId}` : onlineTargetUser.id)
        : data.targetUserId;
    const targetSummary =
      onlineTargetUser
        ? buildOnlineUserSummary(onlineTargetUser)
        : buildStableUserSummary(targetStableId);

    if (!targetSummary) {
      socket.emit("channel-error", "User not found");
      return;
    }

    if (targetStableId === myStableId) {
      socket.emit("channel-error", "Cannot create a DM with yourself");
      return;
    }

    const stableMemberIds = [myStableId, targetStableId].sort();
    const dmId = `dm-${stableMemberIds.join('-')}`;

    if (channels.has(dmId)) {
      socket.emit("dm-created", {
        channelId: dmId,
        otherUser: targetSummary,
        channel: channels.get(dmId)
      });
      return;
    }

    if (dmChannelExists(dmId)) {
      const loaded = loadPersistedDmChannel(dmId);
      if (loaded) {
        channels.set(dmId, loaded.channel);
        if (!channelMessages.has(dmId)) {
          channelMessages.set(dmId, loaded.messages);
        }
        socket.emit("dm-created", {
          channelId: dmId,
          otherUser: targetSummary,
          channel: loaded.channel
        });
        return;
      }
    }

    const createdAt = Date.now();
    const dmChannel = {
      id: dmId,
      name: `${user.username}, ${targetSummary.username}`,
      createdAt,
      type: 'dm' as const,
      members: stableMemberIds,
      autoDeleteAfter: DEFAULT_DM_RETENTION,
      persistMessages: true,
      recipientNotified: false
    } as TChannel;

    channels.set(dmId, dmChannel);
    channelMessages.set(dmId, []);
    pinnedMessages.set(dmId, new Set());

    try {
      createPersistedDm({
        channelId: dmId,
        name: dmChannel.name,
        createdAt: dmChannel.createdAt,
        createdBy: myStableId,
        myMember: {
          userId: myStableId,
          username: user.username,
          registeredUserId: user.dbUserId,
          joinedAt: createdAt
        },
        targetMember: {
          userId: targetStableId,
          username: targetSummary.username,
          registeredUserId: targetSummary.dbUserId,
          joinedAt: createdAt
        }
      });
    } catch (dbError) {
      console.error('[ChannelRepository] Failed to persist DM:', dbError);
    }

    socket.emit("dm-created", {
      channelId: dmId,
      otherUser: targetSummary,
      channel: dmChannel
    });

    if (logEnabled) {
      log(`DM created: ${dmId} between ${user.username} and ${targetSummary.username}`);
    }
  });

  socket.on("delete-dm", (data: { channelId: string }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const channel = channels.get(data.channelId);
    if (!channel || channel.type !== 'dm') {
      socket.emit("channel-error", "DM channel not found");
      return;
    }

    const myStableId = getSocketStableId();
    if (!channel.members?.includes(myStableId)) {
      socket.emit("channel-error", "Not a member of this DM");
      return;
    }

    channels.delete(data.channelId);
    channelMessages.delete(data.channelId);
    pinnedMessages.delete(data.channelId);

    try {
      deletePersistedChannel(data.channelId);
    } catch (error) {
      console.error('[DM] Failed to delete from DB:', error);
    }

    for (const memberId of channel.members || []) {
      emitToStableUser(memberId, "dm-deleted", { channelId: data.channelId });
    }

    if (logEnabled) {
      log(`DM deleted: ${data.channelId}`);
    }
  });

  socket.on("create-group", (data: { name: string; memberIds: string[] }) => {
    const user = users.get(socket.id);
    if (!user) return;

    if (!/^[a-zA-Z0-9\s\-_]+$/.test(data.name)) {
      socket.emit("channel-error", "Group name must be alphanumeric");
      return;
    }

    const creatorStableId = getSocketStableId();
    const memberIds = [...new Set([creatorStableId, ...data.memberIds])];
    const groupId = `group-${Date.now()}-${creatorStableId}`;
    const createdAt = Date.now();

    const groupChannel = {
      id: groupId,
      name: data.name,
      createdAt,
      type: 'group' as const,
      members: memberIds,
      autoDeleteAfter: DEFAULT_DM_RETENTION,
      persistMessages: true
    } as TChannel;

    channels.set(groupId, groupChannel);
    channelMessages.set(groupId, []);
    pinnedMessages.set(groupId, new Set());

    const memberUsers = memberIds
      .map((stableId) => buildStableUserSummary(stableId))
      .filter((value): value is ConversationUserSummary => Boolean(value));

    try {
      const memberRecords: GroupMemberRecord[] = memberIds.map((stableId) => {
        const memberSummary = buildStableUserSummary(stableId);
        const registeredUserId = stableId.startsWith('user-') ? parseInt(stableId.substring(5), 10) : undefined;
        return {
          channel_id: groupId,
          user_id: stableId,
          username: memberSummary?.username || 'Unknown',
          registered_user_id: registeredUserId,
          joined_at: createdAt,
          role: stableId === creatorStableId ? 'owner' : 'member'
        };
      });

      createPersistedGroup({
        channelId: groupId,
        name: data.name,
        createdAt,
        createdBy: creatorStableId,
        members: memberRecords
      });
    } catch (dbError) {
      console.error('[ChannelRepository] Failed to persist group:', dbError);
    }

    const groupPayload: GroupCreatedPayload = {
      id: groupId,
      name: data.name,
      createdAt,
      type: 'group',
      members: memberIds,
      memberUsers,
      autoDeleteAfter: groupChannel.autoDeleteAfter,
      persistMessages: groupChannel.persistMessages,
      avatar: null
    };

    memberIds.forEach((stableId) => {
      emitToStableUser(stableId, "group-created", groupPayload);
    });
    emitGroupCreatedSideEffects(groupPayload);

    if (logEnabled) {
      log(`Group created: ${data.name} (${groupId}) by ${user.username}`);
    }
  });

  socket.on("leave-group", (data: { channelId: string }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const stableId = getSocketStableId();
    const channel = channels.get(data.channelId);
    if (!channel || channel.type !== 'group') return;

    if (!channel.members?.includes(stableId)) {
      socket.emit("channel-error", "You are not a member of this group");
      return;
    }

    removePersistedGroupMember(data.channelId, stableId);
    channel.members = channel.members.filter((id) => id !== stableId);

    socket.emit("group-removed", { channelId: data.channelId });
    channel.members.forEach((memberId) => {
      emitToStableUser(memberId, "group-member-removed", { channelId: data.channelId, userId: stableId });
    });

    if (channel.members.length === 0) {
      archivePersistedChannel(data.channelId);
      channels.delete(data.channelId);
    }

    if (logEnabled) {
      log(`User ${user.username} left group ${data.channelId}`);
    }
  });

  socket.on("kick-group-member", (data: { channelId: string; targetUserId: string }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const stableId = getSocketStableId();
    const channel = channels.get(data.channelId);
    if (!channel || channel.type !== 'group') return;

    const callerMember = getPersistedGroupMember(data.channelId, stableId);
    if (!callerMember || (callerMember.role !== 'owner' && callerMember.role !== 'admin')) {
      socket.emit("channel-error", "Only the owner or admin can kick members");
      return;
    }

    const targetMember = getPersistedGroupMember(data.channelId, data.targetUserId);
    if (!targetMember) {
      socket.emit("channel-error", "User is not a member of this group");
      return;
    }
    if (targetMember.role === 'owner') {
      socket.emit("channel-error", "Cannot kick the group owner");
      return;
    }

    removePersistedGroupMember(data.channelId, data.targetUserId);
    if (channel.members) {
      channel.members = channel.members.filter((id) => id !== data.targetUserId);
    }

    emitToStableUser(data.targetUserId, "group-removed", { channelId: data.channelId });
    channel.members?.forEach((memberId) => {
      emitToStableUser(memberId, "group-member-removed", { channelId: data.channelId, userId: data.targetUserId });
    });

    if (logEnabled) {
      log(`User ${data.targetUserId} kicked from group ${data.channelId} by ${user.username}`);
    }
  });

  socket.on("add-group-member", (data: { channelId: string; userId: string }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const stableId = getSocketStableId();
    const channel = channels.get(data.channelId);
    if (!channel || channel.type !== 'group') return;

    const callerMember = getPersistedGroupMember(data.channelId, stableId);
    if (!callerMember || (callerMember.role !== 'owner' && callerMember.role !== 'admin')) {
      socket.emit("channel-error", "Only the owner or admin can add members");
      return;
    }

    if (channel.members?.includes(data.userId)) {
      socket.emit("channel-error", "User is already a member");
      return;
    }

    const targetSummary = buildStableUserSummary(data.userId);
    const registeredUserId = data.userId.startsWith('user-') ? parseInt(data.userId.substring(5), 10) : undefined;

    addPersistedGroupMember({
      channel_id: data.channelId,
      user_id: data.userId,
      username: targetSummary?.username || 'Unknown',
      registered_user_id: registeredUserId,
      joined_at: Date.now(),
      role: 'member'
    });

    if (!channel.members) channel.members = [];
    channel.members.push(data.userId);

    channel.members.forEach((memberId) => {
      if (memberId === data.userId) return;
      emitToStableUser(memberId, "group-member-added", {
        channelId: data.channelId,
        userId: data.userId,
        user: targetSummary
      });
    });

    const memberUsers = channel.members
      .map((stableUserId) => buildStableUserSummary(stableUserId))
      .filter((value): value is ConversationUserSummary => Boolean(value));

    emitToStableUser(data.userId, "group-created", {
      id: data.channelId,
      name: channel.name,
      createdAt: channel.createdAt,
      type: 'group',
      members: channel.members,
      memberUsers,
      autoDeleteAfter: channel.autoDeleteAfter,
      persistMessages: channel.persistMessages,
      avatar: getPersistedGroupAvatar(data.channelId)
    });

    if (logEnabled) {
      log(`User ${data.userId} added to group ${data.channelId} by ${user.username}`);
    }
  });

  socket.on("update-group-avatar", (data: { channelId: string; avatarUrl: string | null }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const stableId = getSocketStableId();
    const channel = channels.get(data.channelId);
    if (!channel || channel.type !== 'group') return;

    const callerMember = getPersistedGroupMember(data.channelId, stableId);
    if (!callerMember || (callerMember.role !== 'owner' && callerMember.role !== 'admin')) {
      socket.emit("channel-error", "Only the owner or admin can change the group avatar");
      return;
    }

    updatePersistedGroupAvatar(data.channelId, data.avatarUrl);
    channel.members?.forEach((memberId) => {
      emitToStableUser(memberId, "group-avatar-updated", { channelId: data.channelId, avatar: data.avatarUrl });
    });

    if (logEnabled) {
      log(`Group avatar updated for ${data.channelId} by ${user.username}`);
    }
  });
}
