import type { Socket } from 'socket.io';
import type { BackendPlugin, PluginContext } from '../../../backend/src/plugins/types';

type AssetMode = 'open' | 'presenter';

type AssetKind = 'image' | 'video' | 'gif' | 'shape' | 'text';

interface AssetTransform {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  scaleX: number;
  scaleY: number;
  zIndex: number;
}

interface OverlayAsset {
  id: string;
  kind: AssetKind;
  name: string;
  source?: string;
  text?: string;
  locked: boolean;
  visible: boolean;
  transform: AssetTransform;
  createdBy?: string;
  createdAt: number;
  updatedAt: number;
}

interface ScenePreset {
  id: string;
  name: string;
  assets: OverlayAsset[];
  createdBy?: string;
  createdAt: number;
  updatedAt: number;
}

interface OverlayRoom {
  channelId: string;
  mode: AssetMode;
  presenterUserId?: string;
  assets: OverlayAsset[];
  scenes: ScenePreset[];
  updatedAt: number;
  updatedBy?: string;
}

interface OverlayPayload {
  channelId?: string;
  [key: string]: any;
}

const STORAGE_KEY = 'overlay-rooms';
const MAX_ASSETS = 200;
const MAX_SCENES = 50;

let ctxRef: PluginContext | null = null;
const rooms = new Map<string, OverlayRoom>();

function defaultTransform(): AssetTransform {
  return {
    x: 120,
    y: 120,
    width: 320,
    height: 180,
    rotation: 0,
    opacity: 1,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1
  };
}

function defaultRoom(channelId: string): OverlayRoom {
  return {
    channelId,
    mode: 'presenter',
    assets: [],
    scenes: [],
    updatedAt: Date.now()
  };
}

function getRoom(channelId: string): OverlayRoom {
  const existing = rooms.get(channelId);
  if (existing) return existing;
  const created = defaultRoom(channelId);
  rooms.set(channelId, created);
  return created;
}

function getUsername(ctx: PluginContext, socket: Socket): string {
  const user = ctx.users.get(socket.id);
  return user?.username || 'unknown';
}

function canEdit(room: OverlayRoom, socket: Socket): boolean {
  if (room.mode === 'open') return true;
  return !room.presenterUserId || room.presenterUserId === socket.id;
}

function sanitizeChannelId(data: OverlayPayload): string | null {
  if (typeof data?.channelId !== 'string') return null;
  const channelId = data.channelId.trim();
  return channelId.length ? channelId : null;
}

function clamp(num: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, num));
}

function sanitizeTransform(input: any): AssetTransform {
  const base = defaultTransform();
  if (!input || typeof input !== 'object') return base;
  return {
    x: Number.isFinite(input.x) ? input.x : base.x,
    y: Number.isFinite(input.y) ? input.y : base.y,
    width: clamp(Number.isFinite(input.width) ? input.width : base.width, 1, 10000),
    height: clamp(Number.isFinite(input.height) ? input.height : base.height, 1, 10000),
    rotation: Number.isFinite(input.rotation) ? input.rotation : base.rotation,
    opacity: clamp(Number.isFinite(input.opacity) ? input.opacity : base.opacity, 0, 1),
    scaleX: clamp(Number.isFinite(input.scaleX) ? input.scaleX : base.scaleX, 0.01, 100),
    scaleY: clamp(Number.isFinite(input.scaleY) ? input.scaleY : base.scaleY, 0.01, 100),
    zIndex: Number.isFinite(input.zIndex) ? input.zIndex : base.zIndex
  };
}

function emitState(ctx: PluginContext, channelId: string): void {
  ctx.emitToChannel(channelId, 'asset:state', getRoom(channelId));
}

function serializeRooms(): OverlayRoom[] {
  return [...rooms.values()];
}

async function persistRooms(): Promise<void> {
  if (!ctxRef) return;
  await ctxRef.storage.set(STORAGE_KEY, serializeRooms());
}

async function loadRooms(ctx: PluginContext): Promise<void> {
  const stored = await ctx.storage.get(STORAGE_KEY);
  if (!Array.isArray(stored)) return;

  for (const candidate of stored) {
    if (!candidate || typeof candidate !== 'object') continue;
    const channelId = typeof candidate.channelId === 'string' ? candidate.channelId.trim() : '';
    if (!channelId) continue;

    const room: OverlayRoom = {
      ...defaultRoom(channelId),
      ...candidate,
      channelId,
      assets: Array.isArray(candidate.assets) ? candidate.assets.slice(0, MAX_ASSETS) : [],
      scenes: Array.isArray(candidate.scenes) ? candidate.scenes.slice(0, MAX_SCENES) : []
    };
    rooms.set(channelId, room);
  }
}

function updateRoomMeta(room: OverlayRoom, username: string): void {
  room.updatedAt = Date.now();
  room.updatedBy = username;
}

const plugin: BackendPlugin = {
  name: 'art-assets',

  async onLoad(ctx: PluginContext) {
    ctxRef = ctx;
    await loadRooms(ctx);
    ctx.logger.info('Art Assets backend loaded', { rooms: rooms.size });
  },

  socketHandlers: {
    'asset:get-state': async (socket: Socket, data: OverlayPayload, ctx: PluginContext) => {
      const channelId = sanitizeChannelId(data);
      if (!channelId) {
        socket.emit('asset:error', { message: 'channelId is required' });
        return;
      }
      socket.emit('asset:state', getRoom(channelId));
    },

    'asset:add': async (socket: Socket, data: OverlayPayload, ctx: PluginContext) => {
      const channelId = sanitizeChannelId(data);
      if (!channelId) return;

      const room = getRoom(channelId);
      if (!canEdit(room, socket)) {
        socket.emit('asset:error', { message: 'Presenter lock active' });
        return;
      }

      const kind = typeof data?.kind === 'string' ? data.kind : 'image';
      if (!['image', 'video', 'gif', 'shape', 'text'].includes(kind)) {
        socket.emit('asset:error', { message: 'Invalid asset kind' });
        return;
      }

      const username = getUsername(ctx, socket);
      const now = Date.now();
      const asset: OverlayAsset = {
        id: `asset-${now}-${Math.random().toString(36).slice(2, 8)}`,
        kind: kind as AssetKind,
        name: typeof data?.name === 'string' && data.name.trim() ? data.name.trim() : `Asset ${room.assets.length + 1}`,
        source: typeof data?.source === 'string' ? data.source.trim() : undefined,
        text: typeof data?.text === 'string' ? data.text : undefined,
        locked: false,
        visible: true,
        transform: sanitizeTransform(data?.transform),
        createdBy: username,
        createdAt: now,
        updatedAt: now
      };

      room.assets = [...room.assets, asset].slice(-MAX_ASSETS);
      updateRoomMeta(room, username);
      emitState(ctx, channelId);
      await persistRooms();
    },

    'asset:update': async (socket: Socket, data: OverlayPayload, ctx: PluginContext) => {
      const channelId = sanitizeChannelId(data);
      const assetId = typeof data?.assetId === 'string' ? data.assetId.trim() : '';
      if (!channelId || !assetId) return;

      const room = getRoom(channelId);
      if (!canEdit(room, socket)) {
        socket.emit('asset:error', { message: 'Presenter lock active' });
        return;
      }

      const index = room.assets.findIndex((a) => a.id === assetId);
      if (index < 0) {
        socket.emit('asset:error', { message: 'Asset not found' });
        return;
      }

      const current = room.assets[index];
      if (current.locked) {
        socket.emit('asset:error', { message: 'Asset is locked' });
        return;
      }

      const next: OverlayAsset = {
        ...current,
        name: typeof data?.name === 'string' ? data.name.trim() || current.name : current.name,
        source: typeof data?.source === 'string' ? data.source.trim() : current.source,
        text: typeof data?.text === 'string' ? data.text : current.text,
        visible: typeof data?.visible === 'boolean' ? data.visible : current.visible,
        transform: data?.transform ? sanitizeTransform({ ...current.transform, ...data.transform }) : current.transform,
        updatedAt: Date.now()
      };

      room.assets = [...room.assets.slice(0, index), next, ...room.assets.slice(index + 1)];
      updateRoomMeta(room, getUsername(ctx, socket));
      emitState(ctx, channelId);
      await persistRooms();
    },

    'asset:remove': async (socket: Socket, data: OverlayPayload, ctx: PluginContext) => {
      const channelId = sanitizeChannelId(data);
      const assetId = typeof data?.assetId === 'string' ? data.assetId.trim() : '';
      if (!channelId || !assetId) return;

      const room = getRoom(channelId);
      if (!canEdit(room, socket)) {
        socket.emit('asset:error', { message: 'Presenter lock active' });
        return;
      }

      const nextAssets = room.assets.filter((a) => a.id !== assetId);
      if (nextAssets.length === room.assets.length) {
        socket.emit('asset:error', { message: 'Asset not found' });
        return;
      }

      room.assets = nextAssets;
      updateRoomMeta(room, getUsername(ctx, socket));
      emitState(ctx, channelId);
      await persistRooms();
    },

    'asset:reorder': async (socket: Socket, data: OverlayPayload, ctx: PluginContext) => {
      const channelId = sanitizeChannelId(data);
      const order = Array.isArray(data?.order) ? data.order.filter((id: any) => typeof id === 'string') : [];
      if (!channelId || order.length === 0) return;

      const room = getRoom(channelId);
      if (!canEdit(room, socket)) {
        socket.emit('asset:error', { message: 'Presenter lock active' });
        return;
      }

      const rank = new Map<string, number>();
      order.forEach((id, idx) => rank.set(id, idx + 1));

      room.assets = room.assets
        .map((asset) => ({
          ...asset,
          transform: {
            ...asset.transform,
            zIndex: rank.get(asset.id) ?? asset.transform.zIndex
          },
          updatedAt: Date.now()
        }))
        .sort((a, b) => a.transform.zIndex - b.transform.zIndex);

      updateRoomMeta(room, getUsername(ctx, socket));
      emitState(ctx, channelId);
      await persistRooms();
    },

    'asset:lock': async (socket: Socket, data: OverlayPayload, ctx: PluginContext) => {
      const channelId = sanitizeChannelId(data);
      const assetId = typeof data?.assetId === 'string' ? data.assetId.trim() : '';
      if (!channelId || !assetId) return;

      const room = getRoom(channelId);
      if (!canEdit(room, socket)) {
        socket.emit('asset:error', { message: 'Presenter lock active' });
        return;
      }

      const index = room.assets.findIndex((a) => a.id === assetId);
      if (index < 0) return;

      const current = room.assets[index];
      const next: OverlayAsset = {
        ...current,
        locked: typeof data?.locked === 'boolean' ? data.locked : !current.locked,
        updatedAt: Date.now()
      };

      room.assets = [...room.assets.slice(0, index), next, ...room.assets.slice(index + 1)];
      updateRoomMeta(room, getUsername(ctx, socket));
      emitState(ctx, channelId);
      await persistRooms();
    },

    'asset:toggle-visible': async (socket: Socket, data: OverlayPayload, ctx: PluginContext) => {
      const channelId = sanitizeChannelId(data);
      const assetId = typeof data?.assetId === 'string' ? data.assetId.trim() : '';
      if (!channelId || !assetId) return;

      const room = getRoom(channelId);
      if (!canEdit(room, socket)) {
        socket.emit('asset:error', { message: 'Presenter lock active' });
        return;
      }

      const index = room.assets.findIndex((a) => a.id === assetId);
      if (index < 0) return;

      const current = room.assets[index];
      const next: OverlayAsset = {
        ...current,
        visible: typeof data?.visible === 'boolean' ? data.visible : !current.visible,
        updatedAt: Date.now()
      };

      room.assets = [...room.assets.slice(0, index), next, ...room.assets.slice(index + 1)];
      updateRoomMeta(room, getUsername(ctx, socket));
      emitState(ctx, channelId);
      await persistRooms();
    },

    'asset:scene:save': async (socket: Socket, data: OverlayPayload, ctx: PluginContext) => {
      const channelId = sanitizeChannelId(data);
      if (!channelId) return;

      const room = getRoom(channelId);
      if (!canEdit(room, socket)) {
        socket.emit('asset:error', { message: 'Presenter lock active' });
        return;
      }

      const sceneName = typeof data?.name === 'string' && data.name.trim() ? data.name.trim() : 'Scene';
      const sceneId = typeof data?.sceneId === 'string' && data.sceneId.trim() ? data.sceneId.trim() : `scene-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = Date.now();

      const nextScene: ScenePreset = {
        id: sceneId,
        name: sceneName,
        assets: room.assets.map((a) => ({ ...a })),
        createdBy: getUsername(ctx, socket),
        createdAt: now,
        updatedAt: now
      };

      const idx = room.scenes.findIndex((s) => s.id === sceneId);
      if (idx >= 0) {
        room.scenes = [...room.scenes.slice(0, idx), nextScene, ...room.scenes.slice(idx + 1)];
      } else {
        room.scenes = [...room.scenes, nextScene].slice(-MAX_SCENES);
      }

      updateRoomMeta(room, getUsername(ctx, socket));
      emitState(ctx, channelId);
      await persistRooms();
    },

    'asset:scene:load': async (socket: Socket, data: OverlayPayload, ctx: PluginContext) => {
      const channelId = sanitizeChannelId(data);
      const sceneId = typeof data?.sceneId === 'string' ? data.sceneId.trim() : '';
      if (!channelId || !sceneId) return;

      const room = getRoom(channelId);
      if (!canEdit(room, socket)) {
        socket.emit('asset:error', { message: 'Presenter lock active' });
        return;
      }

      const scene = room.scenes.find((s) => s.id === sceneId);
      if (!scene) {
        socket.emit('asset:error', { message: 'Scene not found' });
        return;
      }

      room.assets = scene.assets.map((a) => ({ ...a, updatedAt: Date.now() }));
      updateRoomMeta(room, getUsername(ctx, socket));
      emitState(ctx, channelId);
      await persistRooms();
    },

    'asset:scene:delete': async (socket: Socket, data: OverlayPayload, ctx: PluginContext) => {
      const channelId = sanitizeChannelId(data);
      const sceneId = typeof data?.sceneId === 'string' ? data.sceneId.trim() : '';
      if (!channelId || !sceneId) return;

      const room = getRoom(channelId);
      if (!canEdit(room, socket)) {
        socket.emit('asset:error', { message: 'Presenter lock active' });
        return;
      }

      room.scenes = room.scenes.filter((s) => s.id !== sceneId);
      updateRoomMeta(room, getUsername(ctx, socket));
      emitState(ctx, channelId);
      await persistRooms();
    },

    'asset:presenter:set': async (socket: Socket, data: OverlayPayload, ctx: PluginContext) => {
      const channelId = sanitizeChannelId(data);
      if (!channelId) return;

      const room = getRoom(channelId);
      if (room.presenterUserId && room.presenterUserId !== socket.id) {
        socket.emit('asset:error', { message: 'Presenter lock already owned' });
        return;
      }

      room.presenterUserId = socket.id;
      room.mode = 'presenter';
      updateRoomMeta(room, getUsername(ctx, socket));
      emitState(ctx, channelId);
      await persistRooms();
    },

    'asset:mode:set': async (socket: Socket, data: OverlayPayload, ctx: PluginContext) => {
      const channelId = sanitizeChannelId(data);
      const mode = typeof data?.mode === 'string' ? data.mode : '';
      if (!channelId || !['open', 'presenter'].includes(mode)) {
        socket.emit('asset:error', { message: 'channelId and valid mode are required' });
        return;
      }

      const room = getRoom(channelId);
      if (room.presenterUserId && room.presenterUserId !== socket.id) {
        socket.emit('asset:error', { message: 'Only presenter can change mode' });
        return;
      }

      room.mode = mode as AssetMode;
      updateRoomMeta(room, getUsername(ctx, socket));
      emitState(ctx, channelId);
      await persistRooms();
    }
  },

  routes: [
    {
      method: 'get',
      path: '/rooms',
      handler: async (_req, res) => {
        res.json({
          success: true,
          rooms: [...rooms.values()].map((room) => ({
            channelId: room.channelId,
            mode: room.mode,
            presenterUserId: room.presenterUserId,
            assets: room.assets.length,
            scenes: room.scenes.length,
            updatedAt: room.updatedAt,
            updatedBy: room.updatedBy
          }))
        });
      }
    },
    {
      method: 'get',
      path: '/room',
      handler: async (req, res) => {
        const channelId = typeof req.query?.channelId === 'string' ? req.query.channelId.trim() : '';
        if (!channelId) {
          res.status(400).json({ success: false, error: 'channelId is required' });
          return;
        }

        res.json({
          success: true,
          room: getRoom(channelId)
        });
      }
    }
  ]
};

export default plugin;
