import type { Socket } from 'socket.io';
import type { BackendPlugin, PluginContext } from '@wabi/plugin-types';

interface QueueTrack {
	id: string;
	title: string;
	source: string;
	requestedBy: string;
	requestedAt: number;
}

interface RoomState {
	channelId: string;
	currentTrack?: QueueTrack;
	queue: QueueTrack[];
	isPlaying: boolean;
	positionSec: number;
	updatedAt: number;
}

const STORAGE_KEY = 'rooms';
const MAX_QUEUE = 120;

let ctxRef: PluginContext | null = null;
const rooms = new Map<string, RoomState>();

function getRoom(channelId: string): RoomState {
	const existing = rooms.get(channelId);
	if (existing) return existing;
	const created: RoomState = {
		channelId,
		queue: [],
		isPlaying: false,
		positionSec: 0,
		updatedAt: Date.now()
	};
	rooms.set(channelId, created);
	return created;
}

function sanitizeString(input: unknown, maxLen: number): string {
	if (typeof input !== 'string') return '';
	return input.trim().slice(0, maxLen);
}

async function persist(): Promise<void> {
	if (!ctxRef) return;
	await ctxRef.storage.set(STORAGE_KEY, [...rooms.values()]);
}

function emitRoomState(ctx: PluginContext, channelId: string): void {
	ctx.emitToChannel(channelId, 'music:state', getRoom(channelId));
}

const plugin: BackendPlugin = {
	name: 'music-sync',

	async onLoad(ctx: PluginContext) {
		ctxRef = ctx;
		const stored = await ctx.storage.get(STORAGE_KEY);
		if (Array.isArray(stored)) {
			for (const item of stored) {
				if (!item || typeof item !== 'object' || typeof item.channelId !== 'string') continue;
				rooms.set(item.channelId, {
					channelId: item.channelId,
					currentTrack: item.currentTrack,
					queue: Array.isArray(item.queue) ? item.queue.slice(0, MAX_QUEUE) : [],
					isPlaying: item.isPlaying === true,
					positionSec: Number.isFinite(item.positionSec) ? Number(item.positionSec) : 0,
					updatedAt: Number.isFinite(item.updatedAt) ? Number(item.updatedAt) : Date.now()
				});
			}
		}
	},

	onConnection(socket: Socket) {
		socket.emit('music:capabilities', {
			commands: ['/music'],
			actions: ['enqueue', 'play', 'pause', 'skip']
		});
	},

	socketHandlers: {
		'music:get-state': (socket: Socket, data: any) => {
			const channelId = sanitizeString(data?.channelId, 128);
			if (!channelId) {
				socket.emit('music:error', { message: 'channelId is required' });
				return;
			}
			socket.emit('music:state', getRoom(channelId));
		},

		'music:enqueue': async (socket: Socket, data: any, ctx: PluginContext) => {
			const channelId = sanitizeString(data?.channelId, 128);
			const source = sanitizeString(data?.source, 600);
			const title = sanitizeString(data?.title, 180) || 'Untitled track';
			if (!channelId || !source) {
				socket.emit('music:error', { message: 'channelId and source are required' });
				return;
			}

			const room = getRoom(channelId);
			const username = ctx.users.get(socket.id)?.username || 'unknown';
			const track: QueueTrack = {
				id: `track-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				title,
				source,
				requestedBy: username,
				requestedAt: Date.now()
			};

			room.queue = [...room.queue, track].slice(0, MAX_QUEUE);
			if (!room.currentTrack) {
				room.currentTrack = room.queue.shift();
				room.positionSec = 0;
				room.isPlaying = false;
			}
			room.updatedAt = Date.now();
			await persist();
			emitRoomState(ctx, channelId);
		},

		'music:play': async (_socket: Socket, data: any, ctx: PluginContext) => {
			const channelId = sanitizeString(data?.channelId, 128);
			const positionSec = Number(data?.positionSec || 0);
			if (!channelId) return;
			const room = getRoom(channelId);
			room.isPlaying = true;
			if (Number.isFinite(positionSec) && positionSec >= 0) room.positionSec = positionSec;
			room.updatedAt = Date.now();
			await persist();
			emitRoomState(ctx, channelId);
		},

		'music:pause': async (_socket: Socket, data: any, ctx: PluginContext) => {
			const channelId = sanitizeString(data?.channelId, 128);
			const positionSec = Number(data?.positionSec || 0);
			if (!channelId) return;
			const room = getRoom(channelId);
			room.isPlaying = false;
			if (Number.isFinite(positionSec) && positionSec >= 0) room.positionSec = positionSec;
			room.updatedAt = Date.now();
			await persist();
			emitRoomState(ctx, channelId);
		},

		'music:skip': async (_socket: Socket, data: any, ctx: PluginContext) => {
			const channelId = sanitizeString(data?.channelId, 128);
			if (!channelId) return;
			const room = getRoom(channelId);
			room.currentTrack = room.queue.shift();
			room.positionSec = 0;
			room.isPlaying = false;
			room.updatedAt = Date.now();
			await persist();
			emitRoomState(ctx, channelId);
		}
	}
};

export default plugin;
