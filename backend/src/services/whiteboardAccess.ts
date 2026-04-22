import type { DbChannel } from "../db/repositories/channelRepository.js";
import type { WhiteboardRecord } from "../db/repositories/whiteboardRepository.js";
import { DEFAULT_WORKSPACE_ID } from "../constants.js";

interface WhiteboardAccessChannelRepository {
  findById(channelId: string): DbChannel | undefined;
}

interface WhiteboardAccessChannelMemberRepository {
  isMember(channelId: string, stableUserId: string): boolean;
}

interface WhiteboardAccessWhiteboardRepository {
  getByBoardId(boardId: string): WhiteboardRecord | null;
  getOrCreateForChannel(channelId: string, actorStableId: string): WhiteboardRecord;
}

interface WhiteboardAccessContext {
  userId: number | null;
  guestSessionId: string | null;
  actorStableId: string | null;
}

interface WhiteboardAccessDeps {
  channelRepository: WhiteboardAccessChannelRepository;
  channelMemberRepository: WhiteboardAccessChannelMemberRepository;
  whiteboardRepository: WhiteboardAccessWhiteboardRepository;
  hasGuestSession: (sessionId: string) => boolean;
  getHighestRole: (userId: number) => string;
  getRolePriority: (roleName: string, workspaceId: string) => number;
  workspaceId?: string;
}

export type WhiteboardChannelAccessResult =
  | { allowed: true; channel: DbChannel }
  | { allowed: false; status: number; error: string };

export type WhiteboardRequestAccessResult =
  | { allowed: true; board: WhiteboardRecord; channel: DbChannel; actorStableId: string }
  | { allowed: false; status: number; error: string };

export function canRequestWhiteboardChannelAccess(
  context: Pick<WhiteboardAccessContext, 'userId' | 'guestSessionId'>,
  channelId: string,
  deps: WhiteboardAccessDeps
): WhiteboardChannelAccessResult {
  const workspaceId = deps.workspaceId || DEFAULT_WORKSPACE_ID;
  const channel = deps.channelRepository.findById(channelId);
  if (!channel) {
    return { allowed: false, status: 404, error: 'Channel not found' };
  }

  const isDmLike = channel.channel_type === 'dm' || channel.channel_type === 'group';
  if (isDmLike) {
    if (!context.userId) {
      return { allowed: false, status: 403, error: 'Registered membership is required for this whiteboard' };
    }
    if (!deps.channelMemberRepository.isMember(channelId, `user-${context.userId}`)) {
      return { allowed: false, status: 403, error: 'Not a member of this whiteboard scope' };
    }
    return { allowed: true, channel };
  }

  if (!context.userId && (!context.guestSessionId || !deps.hasGuestSession(context.guestSessionId))) {
    return { allowed: false, status: 401, error: 'Authentication required' };
  }

  const requiredRole = channel.min_role || 'guest';
  const highestRole = context.userId ? deps.getHighestRole(context.userId) : 'guest';
  if (deps.getRolePriority(highestRole, workspaceId) < deps.getRolePriority(requiredRole, workspaceId)) {
    return { allowed: false, status: 403, error: 'Insufficient role for this whiteboard scope' };
  }

  return { allowed: true, channel };
}

export function getAccessibleWhiteboardForRequest(
  context: WhiteboardAccessContext,
  boardId: string,
  deps: WhiteboardAccessDeps,
  options: { createIfMissing?: boolean } = {}
): WhiteboardRequestAccessResult {
  if (!context.actorStableId) {
    return { allowed: false, status: 401, error: 'Authentication required' };
  }

  let board = deps.whiteboardRepository.getByBoardId(boardId);
  if (!board) {
    if (!options.createIfMissing) {
      return { allowed: false, status: 404, error: 'Whiteboard not found' };
    }
    if (!boardId.startsWith('channel:')) {
      return { allowed: false, status: 404, error: 'Whiteboard not found' };
    }
    const channelId = boardId.slice('channel:'.length);
    const access = canRequestWhiteboardChannelAccess(context, channelId, deps);
    if (!access.allowed) {
      return access;
    }
    board = deps.whiteboardRepository.getOrCreateForChannel(channelId, context.actorStableId);
    return { allowed: true, board, channel: access.channel, actorStableId: context.actorStableId };
  }

  if (board.scopeType !== 'channel') {
    return { allowed: false, status: 400, error: 'Unsupported whiteboard scope' };
  }

  const access = canRequestWhiteboardChannelAccess(context, board.scopeId, deps);
  if (!access.allowed) {
    return access;
  }

  return { allowed: true, board, channel: access.channel, actorStableId: context.actorStableId };
}
