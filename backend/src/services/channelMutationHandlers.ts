import type { MessageRetentionDuration } from "../../../shared/messageRetention.js";

interface UserLike {
  username?: string;
  dbUserId?: number;
}

interface ChannelLike {
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
  voiceSettings?: {
    bitrateMode?: 'auto' | 'low' | 'standard' | 'high';
    userLimit?: number | null;
    forceSolo?: boolean;
  };
}

interface ChannelMutationSocketLike {
  id: string;
  emit(event: string, payload: unknown): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

interface CreateChannelPayload {
  name: string;
  description?: string;
  channelType?: 'text' | 'voice';
  type?: 'text' | 'voice';
  channel_type?: 'text' | 'voice';
  watchQueueEnabled?: boolean;
  minRole?: string;
  parentChannelId?: string;
  isBreakout?: boolean;
  breakoutIndex?: number;
}

interface ThreadCreatePayload {
  parentChannelId: string;
  name: string;
  parentMessageId?: string;
  privateThread?: boolean;
  autoArchiveMinutes?: number;
}

interface UpdateChannelSettingsPayload {
  channelId: string;
  autoDeleteAfter?: MessageRetentionDuration | null;
  persistMessages?: boolean;
  name?: string;
  description?: string;
  watchQueueEnabled?: boolean;
  minRole?: string;
  voiceSettings?: {
    bitrateMode?: 'auto' | 'low' | 'standard' | 'high';
    userLimit?: number | null;
    forceSolo?: boolean;
  };
}

interface PersistedChannelCreatePayload {
  channel_id: string;
  channel_type: string;
  name: string;
  description: string;
  min_role: string;
  created_at: number;
  created_by: string;
  persist_messages: number;
  auto_delete_after?: string | null;
  parent_channel_id?: string | null;
  is_breakout?: number;
  breakout_index?: number | null;
  watch_queue_enabled?: number;
  parent_message_id?: string | null;
  thread_archived?: number;
  thread_locked?: number;
  thread_auto_archive_minutes?: number;
  thread_last_activity_at?: number;
}

interface PersistedChannelSettingsPayload {
  name?: string;
  persist_messages?: number;
  auto_delete_after?: string | null;
  description?: string;
  watch_queue_enabled?: number;
  min_role?: string;
  voice_settings_json?: string | null;
}

interface RegisterChannelMutationHandlersOptions<TUser extends UserLike, TChannel extends ChannelLike> {
  socket: ChannelMutationSocketLike;
  users: Map<string, TUser>;
  channels: Map<string, TChannel>;
  channelMessages: Map<string, unknown[]>;
  pinnedMessages: Map<string, Set<string>>;
  voiceChannelParticipants: Map<string, Set<string>>;
  getSocketHighestRole: () => string;
  getSocketStableId: () => string;
  canAccessChannel: (channel: TChannel) => boolean;
  getUserRoleInfo: (dbUserId?: number) => { highestRole: string };
  roleExists: (roleName: string) => boolean;
  normalizeVoiceSettings: (raw: string | null | undefined) => TChannel['voiceSettings'];
  getVoiceChannelUserLimit: (channel: TChannel | undefined) => number | null;
  emitGlobalEvent: (event: string, payload: unknown) => void;
  emitChannelCreatedSideEffects: (channel: TChannel) => void;
  createPersistedChannel: (payload: PersistedChannelCreatePayload) => void;
  addPersistedChannelMember: (payload: {
    channel_id: string;
    user_id: string;
    username: string;
    registered_user_id?: number;
    joined_at: number;
  }) => void;
  deletePersistedChannel: (channelId: string) => void;
  updatePersistedChannelSettings: (channelId: string, payload: PersistedChannelSettingsPayload) => void;
  buildChannel: (payload: {
    id: string;
    name: string;
    description: string;
    watchQueueEnabled: boolean;
    createdAt: number;
    type: 'text' | 'voice';
    parentChannelId?: string;
    isBreakout: boolean;
    breakoutIndex?: number;
  }) => TChannel;
  buildThreadChannel: (payload: {
    id: string;
    name: string;
    minRole: string;
    createdAt: number;
    type: 'thread_public' | 'thread_private';
    members?: string[];
  parentChannelId: string;
  parentMessageId?: string;
  threadAutoArchiveMinutes: number;
  autoDeleteAfter?: MessageRetentionDuration | null;
  persistMessages: boolean;
  }) => TChannel;
  logEnabled: boolean;
  log: (...args: unknown[]) => void;
}

export function registerChannelMutationHandlers<TUser extends UserLike, TChannel extends ChannelLike>({
  socket,
  users,
  channels,
  channelMessages,
  pinnedMessages,
  voiceChannelParticipants,
  getSocketHighestRole,
  getSocketStableId,
  canAccessChannel,
  getUserRoleInfo,
  roleExists,
  normalizeVoiceSettings,
  getVoiceChannelUserLimit,
  emitGlobalEvent,
  emitChannelCreatedSideEffects,
  createPersistedChannel,
  addPersistedChannelMember,
  deletePersistedChannel,
  updatePersistedChannelSettings,
  buildChannel,
  buildThreadChannel,
  logEnabled,
  log
}: RegisterChannelMutationHandlersOptions<TUser, TChannel>): void {
  socket.on("create-channel", (data: string | CreateChannelPayload) => {
    const traceEnabled = ['1', 'true', 'yes', 'on'].includes(
      (process.env.WABI_CHANNEL_CREATE_TRACE || '').trim().toLowerCase()
    );
    const traceStart = traceEnabled ? Date.now() : 0;
    const trace = (label: string) => {
      if (!traceEnabled) return;
      console.log(`[ChannelCreateTrace] ${label}=${Date.now() - traceStart}ms`);
    };

    const highestRole = getSocketHighestRole();
    if (!['owner', 'admin', 'mod'].includes(highestRole)) {
      socket.emit("channel-error", "Only owner/admin/mod can create channels");
      return;
    }
    trace('role_check');

    const channelName = typeof data === 'string' ? data : data.name;
    const channelDescription = typeof data === 'string' ? '' : (data.description || '');
    const requestedType =
      typeof data === 'string'
        ? 'text'
        : (data.channelType || data.type || data.channel_type || 'text');
    const channelType: 'text' | 'voice' = requestedType === 'voice' ? 'voice' : 'text';
    const channelId = channelName.toLowerCase().replace(/\s+/g, '-');

    if (channels.has(channelId)) {
      socket.emit("channel-error", "Channel already exists");
      return;
    }

    if (!/^[a-zA-Z0-9\s-]+$/.test(channelName)) {
      socket.emit("channel-error", "Channel name must be alphanumeric");
      return;
    }

    const channel = buildChannel({
      id: channelId,
      name: channelName,
      description: channelDescription,
      watchQueueEnabled: typeof data === 'string' ? false : data.watchQueueEnabled === true,
      createdAt: Date.now(),
      type: channelType,
      parentChannelId: typeof data === 'string' ? undefined : data.parentChannelId,
      isBreakout: typeof data === 'string' ? false : data.isBreakout === true,
      breakoutIndex: typeof data === 'string' ? undefined : data.breakoutIndex
    });

    channels.set(channelId, channel);
    channelMessages.set(channelId, []);
    pinnedMessages.set(channelId, new Set());
    trace('in_memory');

    try {
      createPersistedChannel({
        channel_id: channelId,
        channel_type: channelType,
        name: channelName,
        description: channelDescription,
        min_role: 'guest',
        created_at: channel.createdAt,
        created_by: getSocketStableId(),
        parent_channel_id: channel.parentChannelId || null,
        is_breakout: channel.isBreakout ? 1 : 0,
        breakout_index: channel.breakoutIndex || null,
        persist_messages: channel.persistMessages ? 1 : 0,
        auto_delete_after: channel.autoDeleteAfter || null,
        watch_queue_enabled: channel.watchQueueEnabled ? 1 : 0
      });
    } catch (dbError) {
      console.error('[ChannelRepository] Failed to persist channel:', dbError);
    }
    trace('persist');

    emitGlobalEvent("channel-created", channel);
    trace('emit');
    emitChannelCreatedSideEffects(channel);

    if (logEnabled) {
      log(`Channel created: ${channelName}`);
    }
  });

  socket.on("thread:create", (data: ThreadCreatePayload) => {
    const parentChannel = channels.get(data.parentChannelId);
    if (!parentChannel) {
      socket.emit("channel-error", "Parent channel does not exist");
      return;
    }

    if (!canAccessChannel(parentChannel)) {
      socket.emit("channel-error", "Access denied to parent channel");
      return;
    }

    if (parentChannel.type !== 'text' && parentChannel.type !== 'public') {
      socket.emit("channel-error", "Threads can only be created from text channels");
      return;
    }

    const rawName = (data.name || '').trim();
    if (!rawName) {
      socket.emit("channel-error", "Thread name is required");
      return;
    }
    if (rawName.length > 64) {
      socket.emit("channel-error", "Thread name must be 64 characters or fewer");
      return;
    }

    const slug = rawName
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
    const fallbackSlug = `thread-${Date.now().toString(36)}`;
    const baseSlug = slug || fallbackSlug;

    let channelId = `${parentChannel.id}-thread-${baseSlug}`;
    let dedupeCounter = 1;
    while (channels.has(channelId)) {
      dedupeCounter += 1;
      channelId = `${parentChannel.id}-thread-${baseSlug}-${dedupeCounter}`;
    }

    const now = Date.now();
    const requestedArchiveMinutes = data.autoArchiveMinutes ?? 1440;
    const threadAutoArchiveMinutes = Math.min(10080, Math.max(60, requestedArchiveMinutes));
    const threadType: 'thread_public' | 'thread_private' = data.privateThread ? 'thread_private' : 'thread_public';
    const stableCreatorId = getSocketStableId();
    const creator = users.get(socket.id);

    const threadChannel = buildThreadChannel({
      id: channelId,
      name: rawName,
      minRole: parentChannel.minRole || 'guest',
      createdAt: now,
      type: threadType,
      members: data.privateThread ? [stableCreatorId] : undefined,
      parentChannelId: parentChannel.id,
      parentMessageId: data.parentMessageId,
      threadAutoArchiveMinutes,
      autoDeleteAfter: parentChannel.autoDeleteAfter ?? null,
      persistMessages: parentChannel.persistMessages ?? false
    });

    channels.set(channelId, threadChannel);
    channelMessages.set(channelId, []);
    pinnedMessages.set(channelId, new Set());

    try {
      createPersistedChannel({
        channel_id: channelId,
        channel_type: threadType,
        name: rawName,
        description: '',
        min_role: threadChannel.minRole || 'guest',
        created_at: now,
        created_by: stableCreatorId,
        persist_messages: threadChannel.persistMessages ? 1 : 0,
        auto_delete_after: threadChannel.autoDeleteAfter || null,
        parent_channel_id: parentChannel.id,
        parent_message_id: data.parentMessageId || null,
        thread_archived: 0,
        thread_locked: 0,
        thread_auto_archive_minutes: threadAutoArchiveMinutes,
        thread_last_activity_at: now
      });

      if (threadChannel.members && threadChannel.members.length > 0) {
        addPersistedChannelMember({
          channel_id: channelId,
          user_id: stableCreatorId,
          username: creator?.username || 'Unknown',
          registered_user_id: creator?.dbUserId,
          joined_at: now
        });
      }
    } catch (dbError) {
      console.error('[ChannelRepository] Failed to persist thread channel:', dbError);
    }

    if (threadType === 'thread_private') {
      socket.emit("channel-created", threadChannel);
    } else {
      emitGlobalEvent("channel-created", threadChannel);
    }

    emitChannelCreatedSideEffects(threadChannel);

    if (logEnabled) {
      log(`Thread created: ${threadChannel.name} (${threadChannel.id})`);
    }
  });

  socket.on("delete-channel", (channelId: string) => {
    const highestRole = getSocketHighestRole();
    if (!['owner', 'admin', 'mod'].includes(highestRole)) {
      socket.emit("channel-error", "Only owner/admin/mod can delete channels");
      return;
    }

    if (channelId === 'general' || channelId === 'voice') {
      socket.emit("channel-error", "Cannot delete base channels");
      return;
    }

    if (!channels.has(channelId)) {
      socket.emit("channel-error", "Channel does not exist");
      return;
    }

    const childThreadIds = Array.from(channels.values())
      .filter((channel) => channel.parentChannelId === channelId)
      .map((channel) => channel.id);
    for (const threadId of childThreadIds) {
      channels.delete(threadId);
      channelMessages.delete(threadId);
      pinnedMessages.delete(threadId);
      try {
        deletePersistedChannel(threadId);
      } catch (dbError) {
        console.error('[ChannelRepository] Failed to delete child thread from DB:', dbError);
      }
      emitGlobalEvent("channel-deleted", threadId);
    }

    channels.delete(channelId);
    channelMessages.delete(channelId);
    pinnedMessages.delete(channelId);

    try {
      deletePersistedChannel(channelId);
    } catch (dbError) {
      console.error('[ChannelRepository] Failed to delete channel from DB:', dbError);
    }

    emitGlobalEvent("channel-deleted", channelId);
    if (logEnabled) {
      log(`Channel deleted: ${channelId}`);
    }
  });

  socket.on("update-channel-settings", (data: UpdateChannelSettingsPayload) => {
    const channel = channels.get(data.channelId);
    if (!channel) {
      socket.emit("channel-error", "Channel does not exist");
      return;
    }

    let validatedMinRole: string | undefined = data.minRole;
    if (data.minRole !== undefined) {
      const actor = users.get(socket.id);
      const roleInfo = getUserRoleInfo(actor?.dbUserId);
      if (!['owner', 'admin'].includes(roleInfo.highestRole)) {
        socket.emit("channel-error", "Only owner/admin can change channel role access");
        return;
      }
      if (!roleExists(data.minRole)) {
        socket.emit("channel-error", "Invalid minimum role");
        return;
      }
    }

    const actor = users.get(socket.id);
    const actorRole = getUserRoleInfo(actor?.dbUserId).highestRole;
    const actorStableId = getSocketStableId();
    const isConversationChannel = channel.type === 'dm' || channel.type === 'group';
    const isConversationMember = Boolean(isConversationChannel && channel.members?.includes(actorStableId));
    let normalizedVoiceSettings: TChannel['voiceSettings'] | undefined;
    if (data.autoDeleteAfter !== undefined) {
      if (isConversationChannel) {
        if (!isConversationMember) {
          socket.emit("channel-error", "Only conversation members can change disappearing message settings");
          return;
        }
      } else if (!['owner', 'admin'].includes(actorRole)) {
        socket.emit("channel-error", "Only owner/admin can change channel auto-delete settings");
        return;
      }
    }
    if (data.persistMessages !== undefined && isConversationChannel) {
      socket.emit("channel-error", "Conversation history is managed automatically");
      return;
    }
    if (data.persistMessages !== undefined && actorRole !== 'owner') {
      socket.emit("channel-error", "Only owners can change message persistence");
      return;
    }
    if (data.name !== undefined && !['owner', 'admin'].includes(actorRole)) {
      socket.emit("channel-error", "Only owner/admin can rename channels");
      return;
    }
    if (data.watchQueueEnabled !== undefined && !['owner', 'admin'].includes(actorRole)) {
      socket.emit("channel-error", "Only owner/admin can change watch queue channel settings");
      return;
    }
    if (data.voiceSettings !== undefined) {
      if (channel.type !== 'voice') {
        socket.emit("channel-error", "Voice settings can only be changed on voice channels");
        return;
      }
      if (!['owner', 'admin'].includes(actorRole)) {
        socket.emit("channel-error", "Only owner/admin can change voice channel settings");
        return;
      }

      normalizedVoiceSettings = normalizeVoiceSettings(JSON.stringify(data.voiceSettings));
      const effectiveLimit = getVoiceChannelUserLimit({
        ...channel,
        voiceSettings: normalizedVoiceSettings
      });
      const participantCount = voiceChannelParticipants.get(channel.id)?.size || 0;
      if (effectiveLimit !== null && participantCount > effectiveLimit) {
        socket.emit("channel-error", `Current occupancy (${participantCount}) exceeds the configured voice limit (${effectiveLimit})`);
        return;
      }
    }

    if (data.autoDeleteAfter !== undefined) {
      channel.autoDeleteAfter = data.autoDeleteAfter;
    }
    if (data.name !== undefined) {
      channel.name = data.name.trim() || channel.name;
    }
    if (data.persistMessages !== undefined) {
      channel.persistMessages = data.persistMessages;
    }
    if (data.description !== undefined) {
      channel.description = data.description;
    }
    if (data.watchQueueEnabled !== undefined) {
      channel.watchQueueEnabled = data.watchQueueEnabled;
    }
    if (validatedMinRole !== undefined) {
      channel.minRole = validatedMinRole;
    }
    if (data.voiceSettings !== undefined) {
      channel.voiceSettings = normalizedVoiceSettings;
    }
    channels.set(data.channelId, channel);

    if (
      data.autoDeleteAfter !== undefined ||
      data.name !== undefined ||
      data.persistMessages !== undefined ||
      data.description !== undefined ||
      data.watchQueueEnabled !== undefined ||
      data.voiceSettings !== undefined ||
      data.minRole !== undefined
    ) {
      try {
        updatePersistedChannelSettings(data.channelId, {
          name: data.name !== undefined ? (data.name.trim() || channel.name) : undefined,
          persist_messages: data.persistMessages !== undefined ? (data.persistMessages ? 1 : 0) : undefined,
          auto_delete_after: data.autoDeleteAfter !== undefined ? data.autoDeleteAfter : undefined,
          description: data.description,
          watch_queue_enabled: data.watchQueueEnabled !== undefined ? (data.watchQueueEnabled ? 1 : 0) : undefined,
          min_role: validatedMinRole,
          voice_settings_json: data.voiceSettings !== undefined ? (normalizedVoiceSettings ? JSON.stringify(normalizedVoiceSettings) : null) : undefined
        });
      } catch {
        // Channel may not exist in DB yet (in-memory only)
      }
    }

    emitGlobalEvent("channel-settings-updated", {
      channelId: data.channelId,
      autoDeleteAfter: data.autoDeleteAfter,
      persistMessages: data.persistMessages,
      name: data.name,
      description: data.description,
      watchQueueEnabled: data.watchQueueEnabled,
      minRole: data.minRole,
      voiceSettings: data.voiceSettings !== undefined ? normalizedVoiceSettings : undefined
    });

    if (logEnabled) {
      log(`Channel ${data.channelId} settings updated:`, {
        autoDeleteAfter: data.autoDeleteAfter || 'disabled',
        persistMessages: data.persistMessages,
        name: data.name,
        description: data.description,
        watchQueueEnabled: data.watchQueueEnabled,
        minRole: data.minRole,
        voiceSettings: data.voiceSettings !== undefined ? normalizedVoiceSettings : undefined
      });
    }
  });
}
