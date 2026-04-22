interface RateLimitedSocketLike {
  emit(event: string, payload: unknown): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

interface SocketRateBucket {
  count: number;
  resetAt: number;
}

const SOCKET_RATE_LIMITS: Record<string, { max: number; windowMs: number }> = {
  message: { max: 30, windowMs: 10_000 },
  typing: { max: 20, windowMs: 10_000 },
  'edit-message': { max: 20, windowMs: 10_000 },
  'add-reaction': { max: 30, windowMs: 10_000 },
  'remove-reaction': { max: 30, windowMs: 10_000 },
  'whiteboard:snapshot': { max: 20, windowMs: 10_000 },
  'whiteboard:patch': { max: 240, windowMs: 10_000 },
  'whiteboard:cursor': { max: 240, windowMs: 10_000 },
  __default: { max: 60, windowMs: 10_000 }
};

const RATE_LIMITED_EVENTS = new Set([
  'message',
  'typing',
  'edit-message',
  'delete-message',
  'add-reaction',
  'remove-reaction',
  'upload-emoji',
  'toggle-pin-message',
  'whiteboard:snapshot',
  'whiteboard:patch',
  'whiteboard:cursor'
]);

export function applySocketRateLimiting(socket: RateLimitedSocketLike): void {
  const socketRateBuckets = new Map<string, SocketRateBucket>();
  const originalOn = socket.on.bind(socket);

  const checkSocketRate = (eventName: string): boolean => {
    const limit = SOCKET_RATE_LIMITS[eventName] || SOCKET_RATE_LIMITS.__default;
    const now = Date.now();
    let bucket = socketRateBuckets.get(eventName);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + limit.windowMs };
      socketRateBuckets.set(eventName, bucket);
    }
    bucket.count += 1;
    return bucket.count <= limit.max;
  };

  socket.on = function patchedOn(event: string, listener: (...args: any[]) => void) {
    if (!RATE_LIMITED_EVENTS.has(event)) {
      return originalOn(event, listener);
    }
    return originalOn(event, (...args: any[]) => {
      if (!checkSocketRate(event)) {
        socket.emit('rate-limited', { event, retryAfter: 10 });
        return;
      }
      listener(...args);
    });
  } as typeof socket.on;
}
