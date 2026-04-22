import type { MessageRetentionDuration } from "../../../shared/messageRetention.js";

export interface ViewChannel {
  id: string;
  name: string;
  description?: string;
  watchQueueEnabled?: boolean;
  minRole?: string;
  createdAt: number;
  type?: 'text' | 'voice' | 'dm' | 'group' | 'public' | 'thread_public' | 'thread_private';
  members?: string[];
  parentChannelId?: string;
  isBreakout?: boolean;
  breakoutIndex?: number;
  parentMessageId?: string;
  threadArchived?: boolean;
  threadLocked?: boolean;
  threadAutoArchiveMinutes?: number;
  threadLastActivityAt?: number;
  autoDeleteAfter?: MessageRetentionDuration | null;
  persistMessages?: boolean;
  voiceSettings?: unknown;
  recipientNotified?: boolean;
}

interface ViewUser {
  id: string;
  username: string;
  color?: string | null;
  status?: string | null;
  profilePicture?: string | null;
  dbUserId?: number;
}

interface DbChannelLike {
  channel_id: string;
  name: string;
  description?: string | null;
  min_role?: string | null;
  created_at: number;
  channel_type?: string | null;
  parent_channel_id?: string | null;
  is_breakout?: number;
  breakout_index?: number | null;
  parent_message_id?: string | null;
  thread_archived?: number;
  thread_locked?: number;
  thread_auto_archive_minutes?: number | null;
  thread_last_activity_at?: number | null;
  auto_delete_after?: string | null;
  persist_messages?: number;
  voice_settings_json?: string | null;
  watch_queue_enabled?: number;
  avatar?: string | null;
}

interface DbUserLike {
  user_id: number;
  username: string;
  handle?: string | null;
  color?: string | null;
  profile_picture?: string | null;
}

interface ChannelMemberLike {
  user_id: string;
  username: string;
  registered_user_id?: number | null;
}

interface RoleInfoLike {
  roles: string[];
  highestRole: string;
  roleColor: string | null;
}

interface BuildServerMembersSnapshotOptions<TRoleLookup> {
  allDbUsers?: DbUserLike[];
  roleLookup?: TRoleLookup;
  getAllDbUsers: () => DbUserLike[];
  getUserRoleInfo: (dbUserId: number, roleLookup?: TRoleLookup) => RoleInfoLike;
}

interface LoadUserChannelsFromDbOptions<TChannel extends ViewChannel> {
  stableUserId: string;
  currentHighestRole?: string;
  channels: Map<string, TChannel>;
  channelMessages: Map<string, unknown[]>;
  preloadHistoryOnLogin: boolean;
  enableLogging: boolean;
  findChannelsByUserId: (stableUserId: string) => DbChannelLike[];
  getChannelMemberIds: (channelId: string) => string[];
  buildChannel: (dbChannel: DbChannelLike, memberIds: string[]) => TChannel;
  loadRecentMessages: (channelId: string) => unknown[];
  getUserRoleInfo: (dbUserId: number) => RoleInfoLike;
  getRolePriority: (roleName: string) => number;
}

interface EnrichDmChannelsOptions<TChannel extends ViewChannel> {
  channelList: TChannel[];
  myStableId: string;
  registeredUsersByDbId?: Map<number, DbUserLike>;
  resolveSocketId: (stableUserId: string) => string | null;
  users: Map<string, ViewUser>;
  findUserById: (dbUserId: number) => DbUserLike | null;
  getChannelMembers: (channelId: string) => ChannelMemberLike[];
  findChannelById: (channelId: string) => DbChannelLike | null;
}

export function buildServerMembersSnapshot<TRoleLookup>({
  allDbUsers,
  roleLookup,
  getAllDbUsers,
  getUserRoleInfo
}: BuildServerMembersSnapshotOptions<TRoleLookup>) {
  const resolvedUsers = allDbUsers || getAllDbUsers();
  return resolvedUsers.map((user) => {
    const roleInfo = getUserRoleInfo(user.user_id, roleLookup);
    return {
      id: `user-${user.user_id}`,
      dbUserId: user.user_id,
      username: user.username,
      handle: user.handle,
      color: user.color,
      profilePicture: user.profile_picture,
      status: 'offline' as const,
      roles: roleInfo.roles,
      highestRole: roleInfo.highestRole,
      roleColor: roleInfo.roleColor
    };
  });
}

export function loadUserChannelsFromDb<TChannel extends ViewChannel>({
  stableUserId,
  currentHighestRole,
  channels,
  channelMessages,
  preloadHistoryOnLogin,
  enableLogging,
  findChannelsByUserId,
  getChannelMemberIds,
  buildChannel,
  loadRecentMessages,
  getUserRoleInfo,
  getRolePriority
}: LoadUserChannelsFromDbOptions<TChannel>): TChannel[] {
  try {
    const userChannels = findChannelsByUserId(stableUserId);

    for (const dbChannel of userChannels) {
      if (!channels.has(dbChannel.channel_id)) {
        const memberIds = getChannelMemberIds(dbChannel.channel_id);
        channels.set(dbChannel.channel_id, buildChannel(dbChannel, memberIds));

        if (!channelMessages.has(dbChannel.channel_id)) {
          channelMessages.set(dbChannel.channel_id, []);
        }

        if (preloadHistoryOnLogin && (channelMessages.get(dbChannel.channel_id)?.length || 0) === 0) {
          try {
            const clientMessages = loadRecentMessages(dbChannel.channel_id);
            channelMessages.set(dbChannel.channel_id, clientMessages);

            if (enableLogging && clientMessages.length > 0) {
              console.log(`[loadUserChannelsFromDB] Preloaded ${clientMessages.length} messages for channel ${dbChannel.channel_id}`);
            }
          } catch (error) {
            console.error(`[loadUserChannelsFromDB] Failed to preload messages for ${dbChannel.channel_id}:`, error);
          }
        }
      }
    }
  } catch (error) {
    console.error('[loadUserChannelsFromDB] Error loading channels:', error);
  }

  const resolvedHighestRole =
    currentHighestRole ||
    (stableUserId.startsWith('user-')
      ? getUserRoleInfo(parseInt(stableUserId.substring(5), 10)).highestRole
      : 'guest');

  return Array.from(channels.values()).filter((channel) => {
    if (!channel.members || channel.members.length === 0) {
      const requiredRole = channel.minRole || 'guest';
      if (requiredRole === 'guest') return true;
      return getRolePriority(resolvedHighestRole) >= getRolePriority(requiredRole);
    }
    return channel.members.includes(stableUserId);
  });
}

export function enrichDmChannels<TChannel extends ViewChannel>({
  channelList,
  myStableId,
  registeredUsersByDbId,
  resolveSocketId,
  users,
  findUserById,
  getChannelMembers,
  findChannelById
}: EnrichDmChannelsOptions<TChannel>): Array<TChannel & Record<string, unknown>> {
  return channelList.map((channel) => {
    if (channel.type === 'dm' && channel.members) {
      const otherStableId = channel.members.find((memberId) => memberId !== myStableId);
      if (otherStableId) {
        const otherSocketId = resolveSocketId(otherStableId);
        const onlineUser = otherSocketId ? users.get(otherSocketId) : null;

        if (onlineUser) {
          return {
            ...channel,
            otherUser: {
              id: onlineUser.id,
              username: onlineUser.username,
              color: onlineUser.color,
              status: onlineUser.status,
              profilePicture: onlineUser.profilePicture,
              dbUserId: onlineUser.dbUserId
            }
          };
        }

        if (otherStableId.startsWith('user-')) {
          const dbId = parseInt(otherStableId.substring(5), 10);
          const dbUser = registeredUsersByDbId?.get(dbId) || findUserById(dbId);
          if (dbUser) {
            return {
              ...channel,
              otherUser: {
                id: otherStableId,
                username: dbUser.username,
                color: dbUser.color,
                status: 'offline' as const,
                profilePicture: dbUser.profile_picture,
                dbUserId: dbId
              }
            };
          }
        }

        const memberRecords = getChannelMembers(channel.id);
        const otherMember = memberRecords.find((member) => member.user_id === otherStableId);
        if (otherMember) {
          return {
            ...channel,
            otherUser: {
              id: otherStableId,
              username: otherMember.username,
              color: '#888888',
              status: 'offline' as const,
              dbUserId: otherMember.registered_user_id || undefined
            }
          };
        }
      }
    }

    if (channel.type === 'group' && channel.members) {
      const dbChannel = findChannelById(channel.id);
      const memberUsers = channel.members
        .map((stableId) => {
          const socketId = resolveSocketId(stableId);
          const onlineUser = socketId ? users.get(socketId) : null;
          if (onlineUser) {
            return {
              id: onlineUser.id,
              username: onlineUser.username,
              color: onlineUser.color,
              status: onlineUser.status,
              profilePicture: onlineUser.profilePicture,
              dbUserId: onlineUser.dbUserId
            };
          }
          if (stableId.startsWith('user-')) {
            const dbId = parseInt(stableId.substring(5), 10);
            const dbUser = registeredUsersByDbId?.get(dbId) || findUserById(dbId);
            if (dbUser) {
              return {
                id: stableId,
                username: dbUser.username,
                color: dbUser.color,
                status: 'offline' as const,
                profilePicture: dbUser.profile_picture,
                dbUserId: dbId
              };
            }
          }
          return null;
        })
        .filter(Boolean);

      return { ...channel, memberUsers, avatar: dbChannel?.avatar || null };
    }

    return channel;
  });
}
