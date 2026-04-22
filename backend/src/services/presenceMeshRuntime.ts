import { randomBytes, timingSafeEqual } from "crypto";

interface MeshInstanceLeaseLike {
  instanceId: string;
}

interface MeshSocketLeaseLike {
  instanceId: string;
}

interface PresenceLeaseLike {
  stableUserId: string;
  dbUserId?: number | null;
  username?: string | null;
  color?: string | null;
  profilePicture?: string | null;
  status?: string | null;
  connectedAt?: number | null;
}

interface RegisteredDbUserSnapshot {
  user_id: number;
  username: string;
  handle?: string | null;
  color?: string | null;
  profile_picture?: string | null;
  username_font_family?: string | null;
  username_font_size?: string | null;
  username_font_weight?: string | null;
  username_font_style?: string | null;
}

interface SocketServerLike {
  emit(event: string, payload: unknown): boolean;
  to(room: string): { emit(event: string, payload: unknown): boolean };
}

interface PresenceStateEventSocket {
  id: string;
  dbUserId?: number;
}

export interface ActiveUserRecord {
  id: string;
  username: string;
  handle?: string;
  color: string;
  status: 'active' | 'away' | 'busy';
  profilePicture?: string;
  joinedAt?: number;
  workspaceId?: string;
  dbUserId?: number;
  roles?: string[];
  highestRole?: string;
  roleColor?: string | null;
  usernameFont?: {
    family?: string;
    size?: string;
    weight?: string;
    style?: string;
  };
}

export interface MeshInboundDelivery {
  deliveryId: string;
  scope: 'user' | 'broadcast';
  event: string;
  payload: unknown;
  targetStableUserId?: string | null;
  fromInstanceId?: string | null;
  createdAt?: number;
}

interface WorkspaceRoleLookupLike {
  workspaceId: string;
  roleStylesByName: Map<string, { priority: number; color: string | null }>;
  roleInfoByUserId: Map<number, { roles: string[]; highestRole: string; roleColor: string | null }>;
}

interface CreatePresenceMeshRuntimeOptions<TChannel extends { members?: string[] | null | undefined }> {
  io: SocketServerLike;
  channels: Map<string, TChannel>;
  defaultWorkspaceId: string;
  getStableUserId: (socket: PresenceStateEventSocket) => string;
  recordStatePlaneEvent: (domain: string, operation: string, payload: Record<string, unknown>) => void;
  upsertStateMeshPresenceLease: (
    payload: {
      stableUserId: string;
      dbUserId?: number;
      username: string;
      color: string;
      profilePicture?: string;
      status: 'active' | 'away' | 'busy';
    },
    connectedAt: number | null
  ) => number | null;
  deleteStateMeshPresenceLease: (stableUserId: string, connectedAt?: number | null) => void;
  listStateMeshPresenceLeases: () => PresenceLeaseLike[];
  getCurrentStateMeshInstanceId: () => string | null;
  listActiveStateMeshInstanceLeases: () => MeshInstanceLeaseLike[];
  sendStateMeshRemoteDelivery: (payload: {
    deliveryId: string;
    targetInstanceId: string;
    scope: 'broadcast' | 'user';
    event: string;
    payload: unknown;
    targetStableUserId?: string;
    createdAt: number;
  }) => Promise<unknown> | unknown;
  findStateMeshSocketLeaseByStableUserId: (stableUserId: string) => MeshSocketLeaseLike | null | undefined;
  isPluginAdmin: (userId: number) => boolean;
  getAllDbUsers: () => RegisteredDbUserSnapshot[];
  buildWorkspaceRoleLookup: (workspaceId?: string) => WorkspaceRoleLookupLike;
  getUserRoleInfo: (
    dbUserId?: number,
    roleLookup?: WorkspaceRoleLookupLike
  ) => { roles: string[]; highestRole: string; roleColor: string | null };
}

export function createPresenceMeshRuntime<TChannel extends { members?: string[] | null | undefined }>({
  io,
  channels,
  defaultWorkspaceId,
  getStableUserId,
  recordStatePlaneEvent,
  upsertStateMeshPresenceLease,
  deleteStateMeshPresenceLease,
  listStateMeshPresenceLeases,
  getCurrentStateMeshInstanceId,
  listActiveStateMeshInstanceLeases,
  sendStateMeshRemoteDelivery,
  findStateMeshSocketLeaseByStableUserId,
  isPluginAdmin,
  getAllDbUsers,
  buildWorkspaceRoleLookup,
  getUserRoleInfo
}: CreatePresenceMeshRuntimeOptions<TChannel>) {
  const users = new Map<string, ActiveUserRecord>();
  const dbUserIdToSocketId = new Map<number, string>();
  const seenMeshDeliveryIds = new Set<string>();
  const seenMeshDeliveryQueue: string[] = [];
  const maxSeenMeshDeliveries = 50_000;

  const getPublicUserId = (user: Pick<ActiveUserRecord, 'id' | 'dbUserId'>): string => {
    if (typeof user.dbUserId === 'number' && Number.isFinite(user.dbUserId)) {
      return `user-${user.dbUserId}`;
    }
    return user.id;
  };

  const normalizePresenceStatus = (status: string | null | undefined): 'active' | 'away' | 'busy' => {
    if (status === 'away' || status === 'busy') return status;
    return 'active';
  };

  const toPublicUser = (user: ActiveUserRecord): ActiveUserRecord => {
    return {
      ...user,
      id: getPublicUserId(user),
      status: normalizePresenceStatus(user.status),
      joinedAt: user.joinedAt
    };
  };

  const upsertPresenceLeaseForUser = (user: ActiveUserRecord | undefined, connectedAt?: number | null): number | null => {
    if (!user) return null;
    return upsertStateMeshPresenceLease({
      stableUserId: getPublicUserId(user),
      dbUserId: user.dbUserId,
      username: user.username,
      color: user.color,
      profilePicture: user.profilePicture,
      status: user.status
    }, connectedAt ?? user.joinedAt ?? null);
  };

  const deletePresenceLeaseForUser = (
    user: Pick<ActiveUserRecord, 'id' | 'dbUserId'> | undefined,
    connectedAt?: number | null
  ): void => {
    if (!user) return;
    deleteStateMeshPresenceLease(getPublicUserId(user), connectedAt);
  };

  const getMeshConnectionCounts = () => {
    let currentRegisteredUsers = 0;
    for (const user of users.values()) {
      if (user.dbUserId) currentRegisteredUsers += 1;
    }
    const currentConnections = users.size;
    return {
      currentConnections,
      currentRegisteredUsers,
      currentGuestUsers: Math.max(0, currentConnections - currentRegisteredUsers)
    };
  };

  const recordPresenceStateEvent = (
    socket: PresenceStateEventSocket,
    operation: string,
    payload: Record<string, unknown> = {}
  ): void => {
    const user = users.get(socket.id);
    recordStatePlaneEvent('presence', operation, {
      socketId: socket.id,
      stableUserId: getStableUserId(socket),
      dbUserId: socket.dbUserId ?? user?.dbUserId ?? null,
      username: user?.username ?? null,
      status: user?.status ?? null,
      ...payload
    });
  };

  const resolveSocketId = (stableId: string): string | null => {
    if (stableId.startsWith('user-')) {
      const dbId = parseInt(stableId.substring(5), 10);
      return dbUserIdToSocketId.get(dbId) || null;
    }
    return stableId;
  };

  const getMeshSharedToken = (): string | null => {
    const candidates = [
      process.env.WABI_MESH_SHARED_TOKEN,
      process.env.WABI_STDB_AUTH_TOKEN
    ];
    for (const raw of candidates) {
      const value = raw?.trim();
      if (value) return value;
    }
    return null;
  };

  const constantTimeEqualString = (left: string, right: string): boolean => {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  };

  const buildMeshDeliveryId = (): string => {
    return `mesh_${Date.now().toString(36)}_${randomBytes(8).toString('hex')}`;
  };

  const hasSeenMeshDelivery = (deliveryId: string): boolean => {
    return seenMeshDeliveryIds.has(deliveryId);
  };

  const markSeenMeshDelivery = (deliveryId: string): void => {
    seenMeshDeliveryIds.add(deliveryId);
    seenMeshDeliveryQueue.push(deliveryId);
    if (seenMeshDeliveryQueue.length <= maxSeenMeshDeliveries) return;
    const removed = seenMeshDeliveryQueue.shift();
    if (removed) {
      seenMeshDeliveryIds.delete(removed);
    }
  };

  const emitToStableUserLocal = (stableUserId: string, event: string, data: unknown): boolean => {
    const socketId = resolveSocketId(stableUserId);
    if (!socketId || !users.has(socketId)) return false;
    io.to(socketId).emit(event, data);
    return true;
  };

  const emitMeshBroadcast = (event: string, data: unknown): void => {
    const currentInstanceId = getCurrentStateMeshInstanceId();
    if (!currentInstanceId) return;

    for (const lease of listActiveStateMeshInstanceLeases()) {
      if (lease.instanceId === currentInstanceId) continue;
      void sendStateMeshRemoteDelivery({
        deliveryId: buildMeshDeliveryId(),
        targetInstanceId: lease.instanceId,
        scope: 'broadcast',
        event,
        payload: data,
        createdAt: Date.now()
      });
    }
  };

  const emitGlobalEvent = (event: string, data: unknown): void => {
    io.emit(event, data);
    emitMeshBroadcast(event, data);
  };

  const emitToStableUser = (stableUserId: string, event: string, data: unknown): boolean => {
    if (emitToStableUserLocal(stableUserId, event, data)) {
      return true;
    }

    if (!stableUserId.startsWith('user-')) {
      return false;
    }

    const lease = findStateMeshSocketLeaseByStableUserId(stableUserId);
    const currentInstanceId = getCurrentStateMeshInstanceId();
    if (!lease || !currentInstanceId || lease.instanceId === currentInstanceId) {
      return false;
    }

    void sendStateMeshRemoteDelivery({
      deliveryId: buildMeshDeliveryId(),
      targetInstanceId: lease.instanceId,
      scope: 'user',
      event,
      payload: data,
      targetStableUserId: stableUserId,
      createdAt: Date.now()
    });
    return true;
  };

  const emitToChannelLocal = (channelId: string, event: string, data: unknown): void => {
    const channel = channels.get(channelId);
    if (!channel) return;

    if (channel.members && channel.members.length > 0) {
      channel.members.forEach((stableId) => {
        emitToStableUserLocal(stableId, event, data);
      });
    } else {
      emitGlobalEvent(event, data);
    }
  };

  const normalizeMeshInboundDelivery = (raw: unknown): MeshInboundDelivery => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Mesh delivery payload must be an object');
    }

    const input = raw as Record<string, unknown>;
    const deliveryId = typeof input.deliveryId === 'string' ? input.deliveryId.trim() : '';
    const scope = input.scope === 'broadcast' ? 'broadcast' : (input.scope === 'user' ? 'user' : '');
    const event = typeof input.event === 'string' ? input.event.trim() : '';
    if (!deliveryId) throw new Error('Mesh delivery requires deliveryId');
    if (!scope) throw new Error('Mesh delivery requires scope');
    if (!event) throw new Error('Mesh delivery requires event');

    const targetStableUserId =
      typeof input.targetStableUserId === 'string' && input.targetStableUserId.trim().length > 0
        ? input.targetStableUserId.trim()
        : null;

    if (scope === 'user' && !targetStableUserId) {
      throw new Error('User-scoped mesh delivery requires targetStableUserId');
    }

    return {
      deliveryId,
      scope,
      event,
      payload: input.payload,
      targetStableUserId,
      fromInstanceId: typeof input.fromInstanceId === 'string' ? input.fromInstanceId.trim() : null,
      createdAt: typeof input.createdAt === 'number' ? input.createdAt : undefined
    };
  };

  const applyInboundMeshDelivery = (delivery: MeshInboundDelivery): boolean => {
    if (delivery.scope === 'broadcast') {
      io.emit(delivery.event, delivery.payload);
      return true;
    }
    if (delivery.scope === 'user' && delivery.targetStableUserId) {
      return emitToStableUserLocal(delivery.targetStableUserId, delivery.event, delivery.payload);
    }
    return false;
  };

  const emitToRegisteredUser = (dbUserId: number | null | undefined, event: string, data: unknown): void => {
    if (dbUserId == null || !Number.isFinite(dbUserId) || dbUserId <= 0) return;
    emitToStableUser(`user-${Math.floor(dbUserId)}`, event, data);
  };

  const emitToPaymentAdmins = (event: string, data: unknown): void => {
    const delivered = new Set<string>();
    for (const [socketId, user] of users.entries()) {
      if (delivered.has(socketId)) continue;
      if (!user?.dbUserId || !isPluginAdmin(user.dbUserId)) continue;
      delivered.add(socketId);
      io.to(socketId).emit(event, data);
    }
  };

  const buildDistributedUsersSnapshot = (
    allDbUsers: RegisteredDbUserSnapshot[] = getAllDbUsers(),
    roleLookup: WorkspaceRoleLookupLike = buildWorkspaceRoleLookup(defaultWorkspaceId)
  ): ActiveUserRecord[] => {
    const byStableId = new Map<string, ActiveUserRecord>();
    for (const user of users.values()) {
      byStableId.set(getPublicUserId(user), toPublicUser(user));
    }

    const registeredUsersByDbId = new Map(
      allDbUsers
        .filter((user) => typeof user.user_id === 'number')
        .map((user) => [user.user_id, user] as const)
    );

    for (const lease of listStateMeshPresenceLeases()) {
      if (byStableId.has(lease.stableUserId)) continue;

      if (typeof lease.dbUserId === 'number' && Number.isFinite(lease.dbUserId)) {
        const dbUser = registeredUsersByDbId.get(lease.dbUserId);
        if (dbUser) {
          const roleInfo = getUserRoleInfo(lease.dbUserId, roleLookup);
          byStableId.set(lease.stableUserId, {
            id: lease.stableUserId,
            username: dbUser.username,
            handle: dbUser.handle || undefined,
            color: dbUser.color || lease.color || '#7a7a7a',
            status: normalizePresenceStatus(lease.status),
            profilePicture: dbUser.profile_picture || lease.profilePicture || undefined,
            joinedAt: lease.connectedAt ?? undefined,
            dbUserId: lease.dbUserId,
            roles: roleInfo.roles,
            highestRole: roleInfo.highestRole,
            roleColor: roleInfo.roleColor,
            usernameFont: {
              family: dbUser.username_font_family || undefined,
              size: dbUser.username_font_size || undefined,
              weight: dbUser.username_font_weight || undefined,
              style: dbUser.username_font_style || undefined
            }
          });
          continue;
        }
      }

      byStableId.set(lease.stableUserId, {
        id: lease.stableUserId,
        username: lease.username || lease.stableUserId,
        color: lease.color || '#7a7a7a',
        status: normalizePresenceStatus(lease.status),
        profilePicture: lease.profilePicture || undefined,
        joinedAt: lease.connectedAt ?? undefined,
        dbUserId: lease.dbUserId ?? undefined
      });
    }

    return Array.from(byStableId.values());
  };

  return {
    users,
    dbUserIdToSocketId,
    getPublicUserId,
    normalizePresenceStatus,
    toPublicUser,
    upsertPresenceLeaseForUser,
    deletePresenceLeaseForUser,
    getMeshConnectionCounts,
    recordPresenceStateEvent,
    resolveSocketId,
    getMeshSharedToken,
    constantTimeEqualString,
    hasSeenMeshDelivery,
    markSeenMeshDelivery,
    emitMeshBroadcast,
    emitGlobalEvent,
    emitToStableUser,
    emitToChannelLocal,
    normalizeMeshInboundDelivery,
    applyInboundMeshDelivery,
    emitToRegisteredUser,
    emitToPaymentAdmins,
    buildDistributedUsersSnapshot
  };
}
