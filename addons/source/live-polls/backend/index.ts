import type { Socket } from 'socket.io';
import type { BackendPlugin, PluginContext } from '@wabi/plugin-types';

type PollScopeType = 'channel' | 'dm' | 'group';

interface PollOption {
	id: string;
	label: string;
	votes: number;
}

interface PollState {
	id: string;
	scopeType: PollScopeType;
	scopeId: string;
	question: string;
	options: PollOption[];
	allowMultiSelect: boolean;
	createdBy: string;
	createdBySocketId: string;
	createdAt: number;
	closeAt?: number;
	closedAt?: number;
	voters: Record<string, string[]>;
}

const STORAGE_KEY = 'polls';
const MAX_POLLS = 300;
const MAX_OPTIONS = 10;

let ctxRef: PluginContext | null = null;
let polls: PollState[] = [];

function sanitizeString(input: unknown, maxLen: number): string {
	if (typeof input !== 'string') return '';
	return input.trim().slice(0, maxLen);
}

function normalizeScopeType(value: unknown): PollScopeType {
	if (value === 'dm' || value === 'group') return value;
	return 'channel';
}

function recomputeVotes(poll: PollState): void {
	const counts: Record<string, number> = {};
	for (const option of poll.options) counts[option.id] = 0;
	for (const picks of Object.values(poll.voters)) {
		for (const optionId of picks) {
			if (counts[optionId] !== undefined) counts[optionId] += 1;
		}
	}
	poll.options = poll.options.map((option) => ({ ...option, votes: counts[option.id] || 0 }));
}

function trimPolls(next: PollState[]): PollState[] {
	if (next.length <= MAX_POLLS) return next;
	return next.slice(next.length - MAX_POLLS);
}

function getScopeKey(scopeType: PollScopeType, scopeId: string): string {
	return `${scopeType}:${scopeId}`;
}

function getUserName(ctx: PluginContext, socket: Socket): string {
	return ctx.users.get(socket.id)?.username || 'unknown';
}

async function persist(): Promise<void> {
	if (!ctxRef) return;
	await ctxRef.storage.set(STORAGE_KEY, polls);
}

function emitScopePollState(ctx: PluginContext, scopeType: PollScopeType, scopeId: string): void {
	const payload = {
		scopeType,
		scopeId,
		polls: polls.filter((poll) => getScopeKey(poll.scopeType, poll.scopeId) === getScopeKey(scopeType, scopeId))
	};
	ctx.emitToChannel(scopeId, 'poll:state', payload);
}

const plugin: BackendPlugin = {
	name: 'live-polls',

	async onLoad(ctx: PluginContext) {
		ctxRef = ctx;
		const stored = await ctx.storage.get(STORAGE_KEY);
		polls = Array.isArray(stored) ? stored : [];
		ctx.logger.info('Live Polls loaded', { polls: polls.length });
	},

	onConnection(socket: Socket, ctx: PluginContext) {
		socket.emit('poll:capabilities', {
			maxOptions: MAX_OPTIONS,
			scopeTypes: ['channel', 'dm', 'group'],
			commands: ['/poll']
		});
	},

	socketHandlers: {
		'poll:get-state': (socket: Socket, data: any, ctx: PluginContext) => {
			const scopeType = normalizeScopeType(data?.scopeType);
			const scopeId = sanitizeString(data?.scopeId, 128);
			if (!scopeId) {
				socket.emit('poll:error', { message: 'scopeId is required' });
				return;
			}
			socket.emit('poll:state', {
				scopeType,
				scopeId,
				polls: polls.filter((poll) => poll.scopeType === scopeType && poll.scopeId === scopeId)
			});
		},

		'poll:create': async (socket: Socket, data: any, ctx: PluginContext) => {
			const question = sanitizeString(data?.question, 200);
			const scopeType = normalizeScopeType(data?.scopeType);
			const scopeId = sanitizeString(data?.scopeId, 128);
			const allowMultiSelect = data?.allowMultiSelect === true;
			const closeAfterMinutes = Number(data?.closeAfterMinutes || 0);
			const rawOptions = Array.isArray(data?.options) ? data.options : [];
			const options = rawOptions
				.map((item: unknown, index: number) => ({
					id: `opt-${index + 1}`,
					label: sanitizeString(item, 80),
					votes: 0
				}))
				.filter((item: PollOption) => item.label.length > 0)
				.slice(0, MAX_OPTIONS);

			if (!scopeId || !question || options.length < 2) {
				socket.emit('poll:error', { message: 'question, scopeId, and at least 2 options are required' });
				return;
			}

			const now = Date.now();
			const poll: PollState = {
				id: `poll-${now}-${Math.random().toString(36).slice(2, 8)}`,
				scopeType,
				scopeId,
				question,
				options,
				allowMultiSelect,
				createdBy: getUserName(ctx, socket),
				createdBySocketId: socket.id,
				createdAt: now,
				closeAt: Number.isFinite(closeAfterMinutes) && closeAfterMinutes > 0 ? now + closeAfterMinutes * 60_000 : undefined,
				voters: {}
			};

			polls = trimPolls([...polls, poll]);
			await persist();
			emitScopePollState(ctx, scopeType, scopeId);
		},

		'poll:vote': async (socket: Socket, data: any, ctx: PluginContext) => {
			const pollId = sanitizeString(data?.pollId, 128);
			const nextOptionIds = Array.isArray(data?.optionIds)
				? data.optionIds.map((value: unknown) => sanitizeString(value, 40)).filter(Boolean)
				: [];
			const poll = polls.find((item) => item.id === pollId);
			if (!poll) {
				socket.emit('poll:error', { message: 'Poll not found' });
				return;
			}
			if (poll.closedAt || (poll.closeAt && poll.closeAt <= Date.now())) {
				if (!poll.closedAt) {
					poll.closedAt = Date.now();
					await persist();
				}
				socket.emit('poll:error', { message: 'Poll is closed' });
				emitScopePollState(ctx, poll.scopeType, poll.scopeId);
				return;
			}

			const allowedOptionIds = new Set(poll.options.map((option) => option.id));
			const selected = Array.from(new Set(nextOptionIds.filter((id) => allowedOptionIds.has(id))));
			if (selected.length === 0) {
				socket.emit('poll:error', { message: 'Select at least one valid option' });
				return;
			}
			if (!poll.allowMultiSelect && selected.length > 1) {
				socket.emit('poll:error', { message: 'This poll allows only one option' });
				return;
			}

			poll.voters[socket.id] = selected;
			recomputeVotes(poll);
			await persist();
			emitScopePollState(ctx, poll.scopeType, poll.scopeId);
		},

		'poll:close': async (socket: Socket, data: any, ctx: PluginContext) => {
			const pollId = sanitizeString(data?.pollId, 128);
			const poll = polls.find((item) => item.id === pollId);
			if (!poll) {
				socket.emit('poll:error', { message: 'Poll not found' });
				return;
			}
			if (poll.createdBySocketId !== socket.id) {
				socket.emit('poll:error', { message: 'Only poll creator can close this poll' });
				return;
			}
			poll.closedAt = Date.now();
			await persist();
			emitScopePollState(ctx, poll.scopeType, poll.scopeId);
		}
	}
};

export default plugin;
