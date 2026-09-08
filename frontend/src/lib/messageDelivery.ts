/** Application receipts, not Socket.IO emit completion. No UI/store imports. */
export const UNCONFIRMED_MESSAGE = 'Delivery not confirmed. This message may have been sent; check the conversation before sending again.';
export type MessageReceiptKey = { channelId: string; clientMessageId: string };
export type MessageAcceptance = MessageReceiptKey & { messageId: string; timestamp: number };
export type MessageFailure = MessageReceiptKey & { outcome: 'rejected' | 'unknown'; error: string };
export type MessageSettlement = { status: 'synced' } | { status: 'failed'; error: string; outcome: 'rejected' | 'unknown' };

type CorrelatedMessage = { id?: string; userId?: string; senderStableId?: string; clientMessageId?: string };
function sender(message: CorrelatedMessage): string | null {
  if (message.userId && message.senderStableId && message.userId !== message.senderStableId) return null;
  return message.senderStableId || message.userId || null;
}
export function isOwnMessage(message: CorrelatedMessage, user: { id: string; dbUserId?: number | null } | null): boolean {
  if (!user) return false;
  const id = Number.isSafeInteger(user.dbUserId) && (user.dbUserId as number) > 0 ? `user-${user.dbUserId}` : user.id;
  return !!id && sender(message) === id;
}
/** Client nonces are sender-scoped; peers cannot claim another sender's intent. */
export function isSameMessageIdentity(candidate: CorrelatedMessage, incoming: CorrelatedMessage): boolean {
  if (candidate.clientMessageId && candidate.clientMessageId === incoming.clientMessageId) {
    return !!sender(candidate) && sender(candidate) === sender(incoming);
  }
  if (candidate.id && candidate.id === incoming.id) {
    return !(candidate.clientMessageId && incoming.clientMessageId && candidate.clientMessageId !== incoming.clientMessageId);
  }
  return false;
}

function receiptKey(value: any): value is MessageReceiptKey {
  return typeof value?.channelId === 'string' && !!value.channelId.trim() &&
    typeof value.clientMessageId === 'string' && !!value.clientMessageId.trim();
}

export function parseMessageAcceptance(value: unknown): MessageAcceptance | null {
  const payload = value as MessageAcceptance;
  if (!receiptKey(payload) || typeof payload.messageId !== 'string' || !payload.messageId.trim() ||
    payload.messageId.startsWith('optimistic:') || !Number.isFinite(payload.timestamp) || payload.timestamp < 0) return null;
  return { channelId: payload.channelId, clientMessageId: payload.clientMessageId,
    messageId: payload.messageId, timestamp: payload.timestamp };
}

export function parseMessageFailure(value: unknown): MessageFailure | null {
  const payload = value as MessageFailure;
  if (!receiptKey(payload)) return null;
  const rejected = payload.outcome === 'rejected';
  // An old server's unclassified failure does not prove the write never happened.
  return { channelId: payload.channelId, clientMessageId: payload.clientMessageId,
    outcome: rejected ? 'rejected' : 'unknown',
    error: rejected && typeof payload.error === 'string' && payload.error.trim()
      ? `Not sent: ${payload.error.slice(0,500)}` : UNCONFIRMED_MESSAGE };
}

/** One bounded deadline per submitted intent, shared by online and queued sends. */
export class MessageDeliveryTracker {
  private sockets = new WeakMap<object, Map<string, { finish: (unknown: boolean) => void }>>();
  constructor(
    private timeoutMs = 15_000,
    private schedule = setTimeout.bind(globalThis),
    private cancelTimer = clearTimeout.bind(globalThis)
  ) {}
  private key(key: MessageReceiptKey): string { return JSON.stringify([key.channelId, key.clientMessageId]); }
  has(socket: object, key: MessageReceiptKey): boolean { return this.sockets.get(socket)?.has(this.key(key)) ?? false; }
  start(socket: object, key: MessageReceiptKey, onUnknown: () => void, dispose: () => void = () => {}): () => void {
    let entries = this.sockets.get(socket);
    if (!entries) { entries = new Map(); this.sockets.set(socket, entries); }
    const id = this.key(key);
    if (entries.has(id)) throw new Error('This message already has a pending delivery attempt');
    let done = false;
    const finish = (unknown: boolean) => {
      if (done) return;
      done = true;
      this.cancelTimer(timer);
      entries!.delete(id);
      dispose();
      if (unknown) onUnknown();
    };
    const timer = this.schedule(() => finish(true), this.timeoutMs);
    // Unit fixtures/browser commands must not keep a process alive on their own.
    timer?.unref?.();
    entries.set(id, { finish });
    return () => finish(false);
  }
  settle(socket: object, key: MessageReceiptKey): void { this.sockets.get(socket)?.get(this.key(key))?.finish(false); }
  unconfirm(socket: object, key?: MessageReceiptKey): void {
    const entries = this.sockets.get(socket);
    if (key) entries?.get(this.key(key))?.finish(true);
    else for (const pending of [...(entries?.values() ?? [])]) pending.finish(true);
  }
}

export const messageDeliveries = new MessageDeliveryTracker();
