import type { Socket } from 'socket.io';
import type { PluginContext } from '@wabi/plugin-types';

type WatchControlMode = 'open' | 'presenter' | 'vote';
type WatchActionType = 'play' | 'pause' | 'seek' | 'skip';

interface QueueItem {
  id: string;
  videoId: string;
  title?: string;
  requestedBy?: string;
  requestedAt: number;
}

type QueueMoveDirection = 'up' | 'down' | 'top' | 'bottom';

interface WatchAction {
  id: string;
  type: WatchActionType;
  channelId: string;
  requestedBy?: string;
  requestedAt: number;
  scheduledAt: number;
  payload?: Record<string, any>;
}

interface VoteState {
  id: string;
  action: WatchAction;
  yes: string[];
  no: string[];
  threshold: number;
  expiresAt: number;
}

export interface ChannelWatchState {
  channelId: string;
  currentVideoId?: string;
  positionSec: number;
  isPlaying: boolean;
  playbackRate: number;
  controlMode: WatchControlMode;
  presenterUserId?: string;
  queue: QueueItem[];
  videoRequestStats?: Record<string, { count: number; lastRequestedAt: number; lastRequestedBy?: string }>;
  queueModerated?: boolean;
  pendingQueue?: QueueItem[];
  pendingVote?: VoteState;
  updatedAt: number;
  updatedBy?: string;
}

interface WatchPayload {
  channelId?: string;
  [key: string]: any;
}

const DEFAULT_COMMIT_WINDOW_MS = 700;
const MAX_QUEUE_ITEMS = 100;
const VOTE_DURATION_MS = 12000;
const SUBMIT_COOLDOWN_MS = 3000;
const MAX_QUEUE_ITEMS_PER_USER = 5;

export function createDefaultRoom(channelId: string): ChannelWatchState {
  return {
    channelId,
    positionSec: 0,
    isPlaying: false,
    playbackRate: 1,
    controlMode: 'presenter',
    queue: [],
    videoRequestStats: {},
    queueModerated: false,
    pendingQueue: [],
    updatedAt: Date.now()
  };
}

export function extractChannelId(data: WatchPayload): string | null {
  if (!data || typeof data.channelId !== 'string') return null;
  const channelId = data.channelId.trim();
  return channelId.length > 0 ? channelId : null;
}

export function extractYouTubeVideoId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const idPattern = /^[a-zA-Z0-9_-]{11}$/;
  if (idPattern.test(raw)) return raw;
  try {
    const url = new URL(raw);
    if (url.hostname.includes('youtu.be')) {
      const shortId = url.pathname.replace('/', '').trim();
      return idPattern.test(shortId) ? shortId : null;
    }
    if (url.hostname.includes('youtube.com')) {
      const v = url.searchParams.get('v') || '';
      if (idPattern.test(v)) return v;
      const segments = url.pathname.split('/').filter(Boolean);
      const embedIndex = segments.findIndex((s) => s === 'embed' || s === 'shorts');
      if (embedIndex >= 0 && segments[embedIndex + 1] && idPattern.test(segments[embedIndex + 1])) {
        return segments[embedIndex + 1];
      }
    }
  } catch {
    return null;
  }
  return null;
}

function getUsername(ctx: PluginContext, socket: Socket): string {
  const user = ctx.users.get(socket.id);
  return user?.username || 'unknown';
}

export function canControl(room: ChannelWatchState, socket: Socket): boolean {
  if (room.controlMode === 'open') return true;
  if (room.controlMode === 'presenter') {
    return !room.presenterUserId || room.presenterUserId === socket.id;
  }
  return false;
}

export function applyAction(ctx: PluginContext, room: ChannelWatchState, action: WatchAction): void {
  switch (action.type) {
    case 'play':
      room.isPlaying = true;
      if (typeof action.payload?.positionSec === 'number') room.positionSec = Math.max(0, action.payload.positionSec);
      break;
    case 'pause':
      room.isPlaying = false;
      if (typeof action.payload?.positionSec === 'number') room.positionSec = Math.max(0, action.payload.positionSec);
      break;
    case 'seek': {
      const target = Number(action.payload?.positionSec ?? room.positionSec);
      room.positionSec = Number.isFinite(target) ? Math.max(0, target) : room.positionSec;
      break;
    }
    case 'skip': {
      const next = room.queue.shift();
      if (next) { room.currentVideoId = next.videoId; room.positionSec = 0; }
      room.isPlaying = false;
      break;
    }
  }
  room.updatedAt = Date.now();
  room.updatedBy = action.requestedBy;
  ctx.emitToChannel(room.channelId, 'watch:action', action);
  ctx.emitToChannel(room.channelId, 'watch:state', room);
}

function createAction(type: WatchActionType, channelId: string, requestedBy: string, payload: Record<string, any> | undefined): WatchAction {
  const now = Date.now();
  return {
    id: `watch-action-${now}-${Math.random().toString(36).slice(2, 8)}`,
    type, channelId, requestedBy, requestedAt: now, scheduledAt: now + DEFAULT_COMMIT_WINDOW_MS, payload
  };
}

function activeChannelUserCount(ctx: PluginContext, channelId: string): number {
  const channel = ctx.channels.get(channelId);
  const users = channel?.users;
  if (Array.isArray(users)) return Math.max(1, users.length);
  return 1;
}

function resolveVote(ctx: PluginContext, room: ChannelWatchState): void {
  const vote = room.pendingVote;
  if (!vote) return;
  const passed = vote.yes.length >= vote.threshold;
  const result = { voteId: vote.id, channelId: room.channelId, passed, yes: vote.yes.length, no: vote.no.length, action: vote.action };
  room.pendingVote = undefined;
  room.updatedAt = Date.now();
  ctx.emitToChannel(room.channelId, 'watch:vote:resolved', result);
  if (passed) applyAction(ctx, room, vote.action);
  else ctx.emitToChannel(room.channelId, 'watch:state', room);
}

function queueControlBlocked(room: ChannelWatchState, socket: Socket): string | null {
  if (room.controlMode === 'vote') return 'Room is in vote mode. Queue control is locked.';
  if (!canControl(room, socket)) return 'Control is presenter-locked';
  return null;
}

function queueModerationBlocked(room: ChannelWatchState, socket: Socket): string | null {
  if (room.controlMode === 'vote') return 'Room is in vote mode. Queue moderation is locked.';
  if (!canControl(room, socket)) return 'Control is presenter-locked';
  return null;
}

function makeSubmitKey(channelId: string, socketId: string): string {
  return `${channelId}:${socketId}`;
}

function isDuplicateVideo(room: ChannelWatchState, videoId: string): boolean {
  if (room.currentVideoId === videoId) return true;
  if (room.queue.some((q) => q.videoId === videoId)) return true;
  if ((room.pendingQueue || []).some((q) => q.videoId === videoId)) return true;
  return false;
}

function bumpVideoInterest(room: ChannelWatchState, videoId: string, requestedBy: string): number {
  const nextStats = { ...(room.videoRequestStats || {}) };
  const current = nextStats[videoId];
  nextStats[videoId] = { count: (current?.count || 0) + 1, lastRequestedAt: Date.now(), lastRequestedBy: requestedBy };
  room.videoRequestStats = nextStats;
  return nextStats[videoId].count;
}

function moveQueueItem(queue: QueueItem[], queueId: string, direction: QueueMoveDirection): QueueItem[] {
  const index = queue.findIndex((item) => item.id === queueId);
  if (index < 0) return queue;
  const next = [...queue];
  if (direction === 'top') { const [item] = next.splice(index, 1); next.unshift(item); return next; }
  if (direction === 'bottom') { const [item] = next.splice(index, 1); next.push(item); return next; }
  if (direction === 'up' && index > 0) { [next[index - 1], next[index]] = [next[index], next[index - 1]]; }
  if (direction === 'down' && index < next.length - 1) { [next[index + 1], next[index]] = [next[index], next[index + 1]]; }
  return next;
}

async function emitAndPersist(ctx: PluginContext, channelId: string, room: ChannelWatchState, persistRooms: () => Promise<void>): Promise<void> {
  ctx.emitToChannel(channelId, 'watch:state', room);
  await persistRooms();
}

export function buildSocketHandlers(
  rooms: Map<string, ChannelWatchState>,
  submitCooldown: Map<string, number>,
  persistRooms: () => Promise<void>
): Record<string, (socket: Socket, data: WatchPayload, ctx: PluginContext) => Promise<void> | void> {
  function getRoom(channelId: string): ChannelWatchState {
    const existing = rooms.get(channelId);
    if (existing) return existing;
    const created = createDefaultRoom(channelId);
    rooms.set(channelId, created);
    return created;
  }

  return {
    'watch:get-state': async (socket, data, ctx) => {
      const channelId = extractChannelId(data);
      if (!channelId) { socket.emit('watch:error', { message: 'channelId is required' }); return; }
      socket.emit('watch:state', getRoom(channelId));
    },

    'watch:add': async (socket, data, ctx) => {
      const channelId = extractChannelId(data);
      const raw = typeof data?.url === 'string' ? data.url : (typeof data?.videoId === 'string' ? data.videoId : '');
      if (!channelId || !raw) { socket.emit('watch:error', { message: 'channelId and url/videoId are required' }); return; }
      const videoId = extractYouTubeVideoId(raw);
      if (!videoId) { socket.emit('watch:error', { message: 'Invalid YouTube URL or video ID' }); return; }
      const room = getRoom(channelId);
      const username = getUsername(ctx, socket);
      const submitKey = makeSubmitKey(channelId, socket.id);
      const now = Date.now();
      const cooldownUntil = submitCooldown.get(submitKey) || 0;
      if (cooldownUntil > now) { socket.emit('watch:error', { message: 'Submitting too quickly. Please wait a moment before adding another link.' }); return; }
      const requestCount = bumpVideoInterest(room, videoId, username);
      if (isDuplicateVideo(room, videoId)) { socket.emit('watch:error', { message: `That video is already current, queued, or pending (requested ${requestCount} times).` }); await emitAndPersist(ctx, channelId, room, persistRooms); return; }
      const ownQueueCount = room.queue.filter((q) => q.requestedBy === username).length + (room.pendingQueue || []).filter((q) => q.requestedBy === username).length;
      if (ownQueueCount >= MAX_QUEUE_ITEMS_PER_USER) { socket.emit('watch:error', { message: `Queue limit reached (${MAX_QUEUE_ITEMS_PER_USER} per user).` }); return; }
      submitCooldown.set(submitKey, now + SUBMIT_COOLDOWN_MS);
      const item: QueueItem = { id: `queue-${now}-${Math.random().toString(36).slice(2, 8)}`, videoId, title: typeof data?.title === 'string' ? data.title : undefined, requestedBy: username, requestedAt: now };
      const requesterCanBypassModeration = canControl(room, socket);
      if (room.queueModerated && !requesterCanBypassModeration) {
        room.pendingQueue = [...(room.pendingQueue || []), item].slice(0, MAX_QUEUE_ITEMS);
        room.updatedAt = Date.now(); room.updatedBy = item.requestedBy;
        await emitAndPersist(ctx, channelId, room, persistRooms);
        socket.emit('watch:queued:pending', { channelId, queueId: item.id, videoId: item.videoId });
        return;
      }
      room.queue = [...room.queue, item].slice(0, MAX_QUEUE_ITEMS);
      if (!room.currentVideoId) { room.currentVideoId = item.videoId; room.queue = room.queue.filter((q) => q.id !== item.id); }
      room.updatedAt = Date.now(); room.updatedBy = item.requestedBy;
      await emitAndPersist(ctx, channelId, room, persistRooms);
    },

    'watch:queue:moderation:set': async (socket, data, ctx) => {
      const channelId = extractChannelId(data);
      const enabled = data?.enabled === true;
      if (!channelId) return;
      const room = getRoom(channelId);
      const blocked = queueModerationBlocked(room, socket);
      if (blocked) { socket.emit('watch:error', { message: blocked }); return; }
      room.queueModerated = enabled; room.updatedAt = Date.now(); room.updatedBy = getUsername(ctx, socket);
      await emitAndPersist(ctx, channelId, room, persistRooms);
    },

    'watch:queue:approve': async (socket, data, ctx) => {
      const channelId = extractChannelId(data);
      const queueId = typeof data?.queueId === 'string' ? data.queueId.trim() : '';
      if (!channelId || !queueId) return;
      const room = getRoom(channelId);
      const blocked = queueModerationBlocked(room, socket);
      if (blocked) { socket.emit('watch:error', { message: blocked }); return; }
      const pending = room.pendingQueue || [];
      const idx = pending.findIndex((q) => q.id === queueId);
      if (idx < 0) return;
      const [approved] = pending.splice(idx, 1);
      room.pendingQueue = pending;
      room.queue = [...room.queue, approved].slice(0, MAX_QUEUE_ITEMS);
      if (!room.currentVideoId) { room.currentVideoId = approved.videoId; room.queue = room.queue.filter((q) => q.id !== approved.id); }
      room.updatedAt = Date.now(); room.updatedBy = getUsername(ctx, socket);
      await emitAndPersist(ctx, channelId, room, persistRooms);
    },

    'watch:queue:reject': async (socket, data, ctx) => {
      const channelId = extractChannelId(data);
      const queueId = typeof data?.queueId === 'string' ? data.queueId.trim() : '';
      if (!channelId || !queueId) return;
      const room = getRoom(channelId);
      const blocked = queueModerationBlocked(room, socket);
      if (blocked) { socket.emit('watch:error', { message: blocked }); return; }
      const pending = room.pendingQueue || [];
      const nextPending = pending.filter((q) => q.id !== queueId);
      if (nextPending.length === pending.length) return;
      room.pendingQueue = nextPending; room.updatedAt = Date.now(); room.updatedBy = getUsername(ctx, socket);
      await emitAndPersist(ctx, channelId, room, persistRooms);
    },

    'watch:queue:remove': async (socket, data, ctx) => {
      const channelId = extractChannelId(data);
      const queueId = typeof data?.queueId === 'string' ? data.queueId.trim() : '';
      if (!channelId || !queueId) return;
      const room = getRoom(channelId);
      const blocked = queueControlBlocked(room, socket);
      if (blocked) { socket.emit('watch:error', { message: blocked }); return; }
      const sizeBefore = room.queue.length;
      room.queue = room.queue.filter((item) => item.id !== queueId);
      if (room.queue.length === sizeBefore) return;
      room.updatedAt = Date.now(); room.updatedBy = getUsername(ctx, socket);
      await emitAndPersist(ctx, channelId, room, persistRooms);
    },

    'watch:queue:clear': async (socket, data, ctx) => {
      const channelId = extractChannelId(data);
      if (!channelId) return;
      const room = getRoom(channelId);
      const blocked = queueControlBlocked(room, socket);
      if (blocked) { socket.emit('watch:error', { message: blocked }); return; }
      room.queue = []; room.updatedAt = Date.now(); room.updatedBy = getUsername(ctx, socket);
      await emitAndPersist(ctx, channelId, room, persistRooms);
    },

    'watch:queue:move': async (socket, data, ctx) => {
      const channelId = extractChannelId(data);
      const queueId = typeof data?.queueId === 'string' ? data.queueId.trim() : '';
      const direction = typeof data?.direction === 'string' ? data.direction.trim() : '';
      if (!channelId || !queueId || !['up', 'down', 'top', 'bottom'].includes(direction)) return;
      const room = getRoom(channelId);
      const blocked = queueControlBlocked(room, socket);
      if (blocked) { socket.emit('watch:error', { message: blocked }); return; }
      room.queue = moveQueueItem(room.queue, queueId, direction as QueueMoveDirection);
      room.updatedAt = Date.now(); room.updatedBy = getUsername(ctx, socket);
      await emitAndPersist(ctx, channelId, room, persistRooms);
    },

    'watch:queue:play-next': async (socket, data, ctx) => {
      const channelId = extractChannelId(data);
      const queueId = typeof data?.queueId === 'string' ? data.queueId.trim() : '';
      if (!channelId || !queueId) return;
      const room = getRoom(channelId);
      const blocked = queueControlBlocked(room, socket);
      if (blocked) { socket.emit('watch:error', { message: blocked }); return; }
      room.queue = moveQueueItem(room.queue, queueId, 'top');
      room.updatedAt = Date.now(); room.updatedBy = getUsername(ctx, socket);
      await emitAndPersist(ctx, channelId, room, persistRooms);
    },

    'watch:queue:play-now': async (socket, data, ctx) => {
      const channelId = extractChannelId(data);
      const queueId = typeof data?.queueId === 'string' ? data.queueId.trim() : '';
      if (!channelId || !queueId) return;
      const room = getRoom(channelId);
      const blocked = queueControlBlocked(room, socket);
      if (blocked) { socket.emit('watch:error', { message: blocked }); return; }
      const target = room.queue.find((item) => item.id === queueId);
      if (!target) return;
      room.queue = room.queue.filter((item) => item.id !== queueId);
      if (room.currentVideoId) {
        room.queue.unshift({ id: `queue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, videoId: room.currentVideoId, title: undefined, requestedBy: getUsername(ctx, socket), requestedAt: Date.now() });
      }
      room.currentVideoId = target.videoId; room.positionSec = 0; room.isPlaying = false;
      room.updatedAt = Date.now(); room.updatedBy = getUsername(ctx, socket);
      const action = createAction('skip', channelId, room.updatedBy || 'unknown', {});
      ctx.emitToChannel(room.channelId, 'watch:action', action);
      await emitAndPersist(ctx, channelId, room, persistRooms);
    },

    'watch:play': async (socket, data, ctx) => {
      const channelId = extractChannelId(data);
      if (!channelId) return;
      const room = getRoom(channelId);
      const requestedBy = getUsername(ctx, socket);
      if (room.controlMode === 'vote') { socket.emit('watch:error', { message: 'Room is in vote mode. Start a vote instead.' }); return; }
      if (!canControl(room, socket)) { socket.emit('watch:error', { message: 'Control is presenter-locked' }); return; }
      applyAction(ctx, room, createAction('play', channelId, requestedBy, { positionSec: Number(data?.positionSec ?? room.positionSec) }));
    },

    'watch:pause': async (socket, data, ctx) => {
      const channelId = extractChannelId(data);
      if (!channelId) return;
      const room = getRoom(channelId);
      const requestedBy = getUsername(ctx, socket);
      if (room.controlMode === 'vote') { socket.emit('watch:error', { message: 'Room is in vote mode. Start a vote instead.' }); return; }
      if (!canControl(room, socket)) { socket.emit('watch:error', { message: 'Control is presenter-locked' }); return; }
      applyAction(ctx, room, createAction('pause', channelId, requestedBy, { positionSec: Number(data?.positionSec ?? room.positionSec) }));
    },

    'watch:seek': async (socket, data, ctx) => {
      const channelId = extractChannelId(data);
      if (!channelId) return;
      const room = getRoom(channelId);
      const requestedBy = getUsername(ctx, socket);
      if (room.controlMode === 'vote') { socket.emit('watch:error', { message: 'Room is in vote mode. Start a vote instead.' }); return; }
      if (!canControl(room, socket)) { socket.emit('watch:error', { message: 'Control is presenter-locked' }); return; }
      const positionSec = Number(data?.positionSec);
      if (!Number.isFinite(positionSec)) { socket.emit('watch:error', { message: 'positionSec must be a number' }); return; }
      applyAction(ctx, room, createAction('seek', channelId, requestedBy, { positionSec }));
    },

    'watch:skip': async (socket, data, ctx) => {
      const channelId = extractChannelId(data);
      if (!channelId) return;
      const room = getRoom(channelId);
      const requestedBy = getUsername(ctx, socket);
      if (room.controlMode === 'vote') { socket.emit('watch:error', { message: 'Room is in vote mode. Start a vote instead.' }); return; }
      if (!canControl(room, socket)) { socket.emit('watch:error', { message: 'Control is presenter-locked' }); return; }
      applyAction(ctx, room, createAction('skip', channelId, requestedBy, {}));
    },

    'watch:mode:set': async (socket, data, ctx) => {
      const channelId = extractChannelId(data);
      const nextMode = typeof data?.mode === 'string' ? data.mode : '';
      if (!channelId || !['open', 'presenter', 'vote'].includes(nextMode)) { socket.emit('watch:error', { message: 'channelId and valid mode are required' }); return; }
      const room = getRoom(channelId);
      if (room.presenterUserId && room.presenterUserId !== socket.id) { socket.emit('watch:error', { message: 'Only presenter can change mode' }); return; }
      room.controlMode = nextMode as WatchControlMode; room.updatedAt = Date.now(); room.updatedBy = getUsername(ctx, socket);
      await emitAndPersist(ctx, channelId, room, persistRooms);
    },

    'watch:presenter:set': async (socket, data, ctx) => {
      const channelId = extractChannelId(data);
      if (!channelId) return;
      const room = getRoom(channelId);
      if (room.presenterUserId && room.presenterUserId !== socket.id) { socket.emit('watch:error', { message: 'Presenter lock is already owned' }); return; }
      room.presenterUserId = socket.id; room.controlMode = 'presenter'; room.updatedAt = Date.now(); room.updatedBy = getUsername(ctx, socket);
      await emitAndPersist(ctx, channelId, room, persistRooms);
    },

    'watch:vote:start': async (socket, data, ctx) => {
      const channelId = extractChannelId(data);
      const type = typeof data?.actionType === 'string' ? data.actionType : '';
      if (!channelId || !['play', 'pause', 'seek', 'skip'].includes(type)) { socket.emit('watch:error', { message: 'channelId and valid actionType are required' }); return; }
      const room = getRoom(channelId);
      if (room.pendingVote) { socket.emit('watch:error', { message: 'A vote is already active in this room' }); return; }
      const requestedBy = getUsername(ctx, socket);
      const action = createAction(type as WatchActionType, channelId, requestedBy, { positionSec: Number(data?.positionSec ?? room.positionSec) });
      const threshold = Math.max(1, Math.ceil(activeChannelUserCount(ctx, channelId) * 0.5));
      room.pendingVote = { id: `vote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, action, yes: [socket.id], no: [], threshold, expiresAt: Date.now() + VOTE_DURATION_MS };
      room.updatedAt = Date.now(); room.updatedBy = requestedBy;
      await emitAndPersist(ctx, channelId, room, persistRooms);
      setTimeout(() => {
        const current = getRoom(channelId);
        const pending = current.pendingVote;
        if (pending && pending.id === room.pendingVote?.id && Date.now() >= pending.expiresAt) resolveVote(ctx, current);
      }, VOTE_DURATION_MS + 50);
    },

    'watch:vote:cast': async (socket, data, ctx) => {
      const channelId = extractChannelId(data);
      const approve = data?.approve === true;
      if (!channelId) return;
      const room = getRoom(channelId);
      const vote = room.pendingVote;
      if (!vote) { socket.emit('watch:error', { message: 'No active vote in this room' }); return; }
      vote.yes = vote.yes.filter((id) => id !== socket.id);
      vote.no = vote.no.filter((id) => id !== socket.id);
      if (approve) vote.yes.push(socket.id); else vote.no.push(socket.id);
      room.updatedAt = Date.now();
      await emitAndPersist(ctx, channelId, room, persistRooms);
      if (vote.yes.length >= vote.threshold) { resolveVote(ctx, room); return; }
      const channelUsers = activeChannelUserCount(ctx, channelId);
      if (vote.no.length > channelUsers - vote.threshold) resolveVote(ctx, room);
    },

    'watch:sync:ping': (socket, data) => {
      socket.emit('watch:sync:pong', { channelId: data?.channelId, serverTime: Date.now(), clientSentAt: data?.clientSentAt });
    }
  };
}
