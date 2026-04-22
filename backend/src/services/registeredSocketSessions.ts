interface RegisteredSocketLike {
  id: string;
  dbUserId?: number | null;
  isRegistered?: boolean;
  emit(event: string, payload: unknown): boolean;
  disconnect(close?: boolean): void;
}

interface SocketServerLike<TSocket extends RegisteredSocketLike> {
  sockets: {
    sockets: Map<string, TSocket>;
  };
}

interface DisconnectOtherRegisteredSocketsOptions<TSocket extends RegisteredSocketLike> {
  io: SocketServerLike<TSocket>;
  socket: TSocket;
  dbUserId: number;
  dbUserIdToSocketId: Map<number, string>;
}

export function disconnectOtherRegisteredSockets<TSocket extends RegisteredSocketLike>({
  io,
  socket,
  dbUserId,
  dbUserIdToSocketId
}: DisconnectOtherRegisteredSocketsOptions<TSocket>): void {
  for (const [socketId, otherSocket] of io.sockets.sockets) {
    if (socketId === socket.id) continue;
    const otherDbUserId = otherSocket.dbUserId;
    const otherIsRegistered = Boolean(otherSocket.isRegistered);
    if (!otherIsRegistered) continue;
    if (otherDbUserId !== dbUserId) continue;

    const currentMapping = dbUserIdToSocketId.get(dbUserId);
    if (currentMapping === socketId) {
      dbUserIdToSocketId.delete(dbUserId);
    }

    otherSocket.emit('session-revoked', { reason: 'single_session_enforced' });
    otherSocket.disconnect(true);
  }
}
