import { IncomingMessage, ServerResponse } from 'http';
import { getAuthenticatedUserIdFromRequest } from '../auth/requestAuth.js';
import { getUserRoles } from '../auth/roleMiddleware.js';
import {
	stateChannelMemberStore,
	stateChannelStore,
	stateMessageStore,
	stateRbacStore
} from '../state-plane/index.js';
import type { ClientMessage, DbChannel } from '../state-plane/records.js';
import { isRequestBodyTooLargeError, readJsonObjectBody } from '../utils/requestBodies.js';
import type {
	FollowedChannelPollChannelResult,
	FollowedChannelPollRequest,
	FollowedChannelPollResponse
} from '../../../shared/userContracts.js';

const DEFAULT_WORKSPACE_ID = 'default-workspace';
const MAX_CHANNELS_PER_POLL = 64;
const MAX_MESSAGES_PER_CHANNEL = 8;

interface FollowPollRequestContext {
	guestStableUserId?: string | null;
}

function writeJson(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(payload));
}

function normalizeChannelRequests(raw: unknown): FollowedChannelPollRequest[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((entry) => {
			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
			const candidate = entry as Record<string, unknown>;
			const channelId = typeof candidate.channelId === 'string' ? candidate.channelId.trim() : '';
			if (!channelId) return null;
			const afterMessageId =
				typeof candidate.afterMessageId === 'string' && candidate.afterMessageId.trim().length > 0
					? candidate.afterMessageId.trim()
					: null;
			const limit =
				typeof candidate.limit === 'number' && Number.isFinite(candidate.limit)
					? Math.max(1, Math.min(MAX_MESSAGES_PER_CHANNEL, Math.floor(candidate.limit)))
					: undefined;
			return {
				channelId,
				afterMessageId,
				limit
			};
		})
		.filter((entry): entry is FollowedChannelPollRequest => entry !== null)
		.slice(0, MAX_CHANNELS_PER_POLL);
}

function isRoleGatedWorkspaceChannel(channel: DbChannel): boolean {
	return (
		channel.channel_type === 'text' ||
		channel.channel_type === 'voice' ||
		channel.channel_type === 'public' ||
		channel.channel_type === 'thread_public'
	);
}

function isMessageBearingChannel(channel: DbChannel): boolean {
	return channel.channel_type !== 'voice';
}

function getRegisteredStableUserId(userId: number): string {
	return `user-${userId}`;
}

function getHighestRolePriority(userId: number, workspaceId = DEFAULT_WORKSPACE_ID): number {
	const roles = getUserRoles(userId, workspaceId);
	const effectiveRoles = roles.length > 0 ? roles : ['member'];
	return effectiveRoles.reduce((highest, roleName) => {
		return Math.max(highest, stateRbacStore.getRolePriority(roleName, workspaceId));
	}, 0);
}

function canUserAccessChannel(userId: number, channel: DbChannel): boolean {
	if (isRoleGatedWorkspaceChannel(channel)) {
		const requiredRole = channel.min_role || 'guest';
		if (requiredRole === 'guest') return true;
		const requiredPriority = stateRbacStore.getRolePriority(requiredRole, DEFAULT_WORKSPACE_ID);
		return getHighestRolePriority(userId) >= requiredPriority;
	}

	return stateChannelMemberStore.isMember(channel.channel_id, getRegisteredStableUserId(userId));
}

function canGuestAccessChannel(channel: DbChannel): boolean {
	if (!isRoleGatedWorkspaceChannel(channel)) {
		return false;
	}
	return (channel.min_role || 'guest') === 'guest';
}

function toClientMessages(channelId: string, afterMessageId: string | null, limit: number): {
	cursorReset: boolean;
	messages: ClientMessage[];
} {
	let cursorReset = false;

	if (afterMessageId) {
		const cursorMessage = stateMessageStore.findByMessageId(afterMessageId);
		if (!cursorMessage || cursorMessage.channel_id !== channelId) {
			cursorReset = true;
		} else {
			const deltaRows = stateMessageStore.getByChannel(channelId, {
				afterMessageId,
				limit
			});
			return {
				cursorReset: false,
				messages: deltaRows.map((row) => stateMessageStore.toClientFormat(row))
			};
		}
	}

	const latestRows = stateMessageStore.getByChannel(channelId, { limit: 1 });
	return {
		cursorReset,
		messages: latestRows.map((row) => stateMessageStore.toClientFormat(row))
	};
}

export async function handlePollFollowedChannelActivity(
	req: IncomingMessage,
	res: ServerResponse,
	context: FollowPollRequestContext = {}
): Promise<void> {
	try {
		const guestStableUserId =
			typeof context.guestStableUserId === 'string' && context.guestStableUserId.trim().length > 0
				? context.guestStableUserId.trim()
				: null;
		const userId = guestStableUserId ? null : getAuthenticatedUserIdFromRequest(req);
		if (!userId && !guestStableUserId) {
			writeJson(res, 401, { error: 'User not authenticated' });
			return;
		}

		let body: Record<string, unknown>;
		try {
			body = await readJsonObjectBody(req);
		} catch (error) {
			if (isRequestBodyTooLargeError(error)) {
				writeJson(res, 413, { error: 'Follow poll payload too large' });
				return;
			}
			writeJson(res, 400, { error: 'Invalid JSON in request body' });
			return;
		}

		const requestedChannels = normalizeChannelRequests(body.channels);
		if (requestedChannels.length === 0) {
			const responsePayload: FollowedChannelPollResponse<ClientMessage> = {
				success: true,
				serverTime: Date.now(),
				channels: []
			};
			writeJson(res, 200, responsePayload as unknown as Record<string, unknown>);
			return;
		}

		const channels: FollowedChannelPollChannelResult<ClientMessage>[] = [];
		for (const request of requestedChannels) {
			const channel = stateChannelStore.findById(request.channelId);
			if (!channel || !isMessageBearingChannel(channel)) continue;
			if (userId) {
				if (!canUserAccessChannel(userId, channel)) continue;
			} else if (!canGuestAccessChannel(channel)) {
				continue;
			}

			const { cursorReset, messages } = toClientMessages(
				channel.channel_id,
				request.afterMessageId || null,
				request.limit || (request.afterMessageId ? 6 : 1)
			);

			if (messages.length === 0 && !cursorReset) continue;

			channels.push({
				channelId: channel.channel_id,
				channelName: channel.name,
				channelType: channel.channel_type,
				cursorReset,
				messages
			});
		}

		const responsePayload: FollowedChannelPollResponse<ClientMessage> = {
			success: true,
			serverTime: Date.now(),
			channels
		};
		writeJson(res, 200, responsePayload as unknown as Record<string, unknown>);
	} catch (error) {
		console.error('[Following] Poll failed:', error);
		writeJson(res, 500, { error: 'Failed to poll followed channel activity' });
	}
}
