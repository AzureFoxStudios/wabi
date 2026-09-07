import type { Socket } from 'socket.io-client';

type ShareSocket = Pick<Socket, 'id' | 'connected' | 'on' | 'off' | 'emit'>;
type Request = { requestId: string; channelId?: string; targetUserId?: string; membershipRevision?: string };

/** Capture is local until the server confirms the exact call audience. */
export function requestScreenShareAdmission(socket: ShareSocket, data: Request, signal: AbortSignal, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socketId = socket.id;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      socket.off('screen-share-targets', admitted); socket.off('screen-share-error', denied);
      socket.off('disconnect', disconnected); signal.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve();
    };
    const matches = (reply: any) => reply?.requestId === data.requestId;
    const admitted = (reply: any) => {
      if (!matches(reply)) return;
      if (!socket.connected || socket.id !== socketId) return disconnected();
      finish((reply.channelId ?? undefined) === data.channelId && Array.isArray(reply.targets)
        ? undefined : new Error('Invalid screen share admission reply'));
    };
    const denied = (reply: any) => { if (matches(reply)) finish(new Error(reply.error || 'Screen share denied')); };
    const disconnected = () => finish(new Error('Disconnected during screen share admission'));
    const aborted = () => finish(new DOMException('Screen share cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('Screen share admission timed out')), timeoutMs);
    socket.on('screen-share-targets', admitted); socket.on('screen-share-error', denied);
    socket.on('disconnect', disconnected); signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) return aborted();
    if (!socket.connected) return disconnected();
    try { socket.emit('start-screen-share', data); }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}
