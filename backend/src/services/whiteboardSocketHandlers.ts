import type { WhiteboardRecord } from "../db/repositories/whiteboardRepository.js";

interface WhiteboardSocketLike {
  emit(event: string, payload: unknown): boolean;
  join(room: string): Promise<unknown> | unknown;
  leave(room: string): Promise<unknown> | unknown;
  to(room: string): { emit(event: string, payload: unknown): boolean };
  rooms: Iterable<string> & { has(room: string): boolean };
  on(event: string, listener: (...args: any[]) => void): unknown;
}

interface WhiteboardRepositoryLike {
  getOrCreateForChannel(channelId: string, actorStableId: string): WhiteboardRecord;
  getByBoardId(boardId: string): WhiteboardRecord | null;
  saveSnapshot(boardId: string, document: unknown, updatedBy: string): WhiteboardRecord | null;
}

interface RegisterWhiteboardSocketHandlersOptions<TChannel> {
  socket: WhiteboardSocketLike;
  channels: Map<string, TChannel>;
  whiteboardRepository: WhiteboardRepositoryLike;
  getSocketStableId: () => string;
  canAccessChannel: (channel: TChannel) => boolean;
  roomPrefix: string;
  getWhiteboardRoomId: (boardId: string) => string;
  getSerializedPayloadBytes: (value: unknown) => number;
  emitWhiteboardPresence: (boardId: string) => void;
  maxDocumentBytes: number;
  maxLivePayloadBytes: number;
}

export function registerWhiteboardSocketHandlers<TChannel>({
  socket,
  channels,
  whiteboardRepository,
  getSocketStableId,
  canAccessChannel,
  roomPrefix,
  getWhiteboardRoomId,
  getSerializedPayloadBytes,
  emitWhiteboardPresence,
  maxDocumentBytes,
  maxLivePayloadBytes
}: RegisterWhiteboardSocketHandlersOptions<TChannel>): void {
  const emitWhiteboardError = (
    message: string,
    details?: { code?: string; boardId?: string; channelId?: string }
  ): void => {
    socket.emit("whiteboard:error", {
      message,
      ...(details || {})
    });
  };

  const getAccessibleWhiteboardForChannel = (
    channelId: string
  ): { channel: TChannel; board: WhiteboardRecord } | null => {
    const channel = channels.get(channelId);
    if (!channel) {
      emitWhiteboardError(`Channel ${channelId} does not exist`, { channelId, code: 'channel_not_found' });
      return null;
    }
    if (!canAccessChannel(channel)) {
      emitWhiteboardError('Access denied to this whiteboard', { channelId, code: 'access_denied' });
      return null;
    }
    return {
      channel,
      board: whiteboardRepository.getOrCreateForChannel(channelId, getSocketStableId())
    };
  };

  const getAccessibleWhiteboardById = (
    boardId: string
  ): { channel: TChannel; board: WhiteboardRecord } | null => {
    const board = whiteboardRepository.getByBoardId(boardId);
    if (!board) {
      emitWhiteboardError('Whiteboard not found', { boardId, code: 'board_not_found' });
      return null;
    }
    if (board.scopeType !== 'channel') {
      emitWhiteboardError('Unsupported whiteboard scope', { boardId, code: 'unsupported_scope' });
      return null;
    }
    const channel = channels.get(board.scopeId);
    if (!channel) {
      emitWhiteboardError('Whiteboard scope is missing', {
        boardId,
        channelId: board.scopeId,
        code: 'scope_missing'
      });
      return null;
    }
    if (!canAccessChannel(channel)) {
      emitWhiteboardError('Access denied to this whiteboard', {
        boardId,
        channelId: board.scopeId,
        code: 'access_denied'
      });
      return null;
    }
    return { channel, board };
  };

  const isJoinedToWhiteboard = (boardId: string): boolean =>
    socket.rooms.has(getWhiteboardRoomId(boardId));

  const emitWhiteboardSnapshotToSocket = (
    targetSocket: WhiteboardSocketLike,
    board: WhiteboardRecord,
    updatedBy?: string
  ): void => {
    targetSocket.emit("whiteboard:snapshot", {
      boardId: board.boardId,
      channelId: board.scopeId,
      version: board.version,
      persistedAt: board.updatedAt,
      ...(updatedBy ? { updatedBy } : {}),
      document: board.document
    });
  };

  socket.on("whiteboard:join", (data: { channelId?: string }) => {
    const channelId = typeof data?.channelId === 'string' ? data.channelId.trim() : '';
    if (!channelId) {
      emitWhiteboardError('channelId is required', { code: 'invalid_request' });
      return;
    }

    const access = getAccessibleWhiteboardForChannel(channelId);
    if (!access) return;

    const roomId = getWhiteboardRoomId(access.board.boardId);
    void Promise.resolve(socket.join(roomId))
      .then(() => {
        emitWhiteboardSnapshotToSocket(socket, access.board);
        emitWhiteboardPresence(access.board.boardId);
      })
      .catch((error) => {
        console.error('[Whiteboard] Failed to join room:', error);
        emitWhiteboardError('Failed to join whiteboard room', {
          boardId: access.board.boardId,
          channelId,
          code: 'join_failed'
        });
      });
  });

  socket.on("whiteboard:leave", (data: { boardId?: string }) => {
    const boardId = typeof data?.boardId === 'string' ? data.boardId.trim() : '';
    if (!boardId) return;

    const access = getAccessibleWhiteboardById(boardId);
    if (!access) return;

    void Promise.resolve(socket.leave(getWhiteboardRoomId(boardId))).finally(() => {
      emitWhiteboardPresence(boardId);
    });
  });

  socket.on("whiteboard:snapshot", (data: { boardId?: string; document?: unknown }) => {
    const boardId = typeof data?.boardId === 'string' ? data.boardId.trim() : '';
    if (!boardId || data?.document === undefined) {
      emitWhiteboardError('boardId and document are required', {
        boardId: boardId || undefined,
        code: 'invalid_request'
      });
      return;
    }

    const access = getAccessibleWhiteboardById(boardId);
    if (!access) return;
    if (!isJoinedToWhiteboard(boardId)) {
      emitWhiteboardError('Join the whiteboard before sending snapshots', {
        boardId,
        channelId: access.board.scopeId,
        code: 'not_joined'
      });
      return;
    }
    if (getSerializedPayloadBytes(data.document) > maxDocumentBytes) {
      emitWhiteboardError('Whiteboard snapshot exceeds the current size limit', {
        boardId,
        channelId: access.board.scopeId,
        code: 'snapshot_too_large'
      });
      return;
    }

    const updatedBy = getSocketStableId();
    const saved = whiteboardRepository.saveSnapshot(boardId, data.document, updatedBy);
    if (!saved) {
      emitWhiteboardError('Failed to save whiteboard snapshot', {
        boardId,
        channelId: access.board.scopeId,
        code: 'save_failed'
      });
      return;
    }

    emitWhiteboardSnapshotToSocket(socket, saved, updatedBy);
    socket.to(getWhiteboardRoomId(boardId)).emit("whiteboard:snapshot", {
      boardId: saved.boardId,
      channelId: saved.scopeId,
      version: saved.version,
      persistedAt: saved.updatedAt,
      updatedBy,
      document: saved.document
    });
  });

  socket.on("whiteboard:patch", (data: { boardId?: string; patch?: unknown }) => {
    const boardId = typeof data?.boardId === 'string' ? data.boardId.trim() : '';
    if (!boardId || data?.patch === undefined) return;

    const access = getAccessibleWhiteboardById(boardId);
    if (!access) return;
    if (!isJoinedToWhiteboard(boardId)) return;
    if (getSerializedPayloadBytes(data.patch) > maxLivePayloadBytes) {
      emitWhiteboardError('Whiteboard patch exceeds the current size limit', {
        boardId,
        channelId: access.board.scopeId,
        code: 'patch_too_large'
      });
      return;
    }

    socket.to(getWhiteboardRoomId(boardId)).emit("whiteboard:patch", {
      boardId,
      channelId: access.board.scopeId,
      userId: getSocketStableId(),
      timestamp: Date.now(),
      patch: data.patch
    });
  });

  socket.on("whiteboard:cursor", (data: { boardId?: string; cursor?: unknown }) => {
    const boardId = typeof data?.boardId === 'string' ? data.boardId.trim() : '';
    if (!boardId) return;

    const access = getAccessibleWhiteboardById(boardId);
    if (!access) return;
    if (!isJoinedToWhiteboard(boardId)) return;
    if (getSerializedPayloadBytes(data.cursor ?? null) > maxLivePayloadBytes) {
      return;
    }

    socket.to(getWhiteboardRoomId(boardId)).emit("whiteboard:cursor", {
      boardId,
      channelId: access.board.scopeId,
      userId: getSocketStableId(),
      timestamp: Date.now(),
      cursor: data.cursor ?? null
    });
  });

  socket.on("disconnecting", () => {
    const boardIds = Array.from(socket.rooms)
      .filter((roomId) => roomId.startsWith(roomPrefix))
      .map((roomId) => roomId.slice(roomPrefix.length));
    if (boardIds.length === 0) return;
    setTimeout(() => {
      for (const boardId of boardIds) {
        emitWhiteboardPresence(boardId);
      }
    }, 0);
  });
}
