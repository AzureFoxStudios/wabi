import type { Socket } from 'socket.io';
import type { BackendPlugin, PluginContext } from '@wabi/plugin-types';
import {
  createDefaultRoom,
  extractChannelId,
  buildSocketHandlers,
  type ChannelWatchState
} from './watchHandlers';

const STORAGE_KEY = 'watch-rooms';
const MAX_QUEUE_ITEMS = 100;

let ctxRef: PluginContext | null = null;
const rooms = new Map<string, ChannelWatchState>();
const submitCooldown = new Map<string, number>();

function serializeRooms(): ChannelWatchState[] {
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
    rooms.set(channelId, {
      ...createDefaultRoom(channelId),
      ...candidate,
      channelId,
      queue: Array.isArray(candidate.queue) ? candidate.queue.slice(0, MAX_QUEUE_ITEMS) : [],
      pendingQueue: Array.isArray(candidate.pendingQueue) ? candidate.pendingQueue.slice(0, MAX_QUEUE_ITEMS) : [],
      videoRequestStats: (candidate.videoRequestStats && typeof candidate.videoRequestStats === 'object') ? candidate.videoRequestStats : {}
    });
  }
}

const plugin: BackendPlugin = {
  name: 'youtube-watch',

  async onLoad(ctx: PluginContext) {
    ctxRef = ctx;
    await loadRooms(ctx);
    ctx.logger.info('YouTube Watch backend loaded', { rooms: rooms.size });
  },

  onConnection(socket: Socket) {
    socket.emit('watch:capabilities', {
      provider: 'youtube',
      modes: ['open', 'presenter', 'vote'],
      actions: ['play', 'pause', 'seek', 'skip'],
      queueActions: ['play-now', 'play-next', 'remove', 'clear', 'move-up', 'move-down', 'move-top', 'move-bottom'],
      moderation: { queueModeration: true, submitCooldownMs: 3000, maxQueueItemsPerUser: 5 },
      sync: { commitWindowMs: 700, notes: 'Phase 1 scaffold: adaptive jitter windows and drift engine planned next.' }
    });
  },

  onDisconnect(socket: Socket) {
    for (const key of submitCooldown.keys()) {
      if (key.endsWith(`:${socket.id}`)) submitCooldown.delete(key);
    }
  },

  socketHandlers: buildSocketHandlers(rooms, submitCooldown, persistRooms),

  routes: [
    {
      method: 'get',
      path: '/rooms',
      handler: async (_req, res) => {
        res.json({ success: true, rooms: serializeRooms(), notes: 'Phase 1 scaffold. Adaptive jitter windows/drift correction are next-phase work.' });
      }
    }
  ]
};

export default plugin;
