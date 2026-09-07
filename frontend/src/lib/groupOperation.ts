import type { Socket } from 'socket.io-client';
import type { Channel } from './socket-types';
import { membershipRevision, validGroupSnapshot } from './groupMembership';

export type GroupOperation = 'create' | 'add' | 'kick' | 'leave';
export type GroupOperationResult = { ok: true; operation: GroupOperation; requestId: string;
  channelId: string; membershipRevision: string; channel: Channel | null };
type GroupSocket = Pick<Socket, 'id' | 'connected' | 'on' | 'off' | 'emit'>;

export class GroupOperationError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'GroupOperationError'; }
}

/** One correlated application result, not Socket.IO's emit/transport receipt.
 * Never buffer membership edits offline or guess whether a timed-out write ran. */
export function requestGroupOperation(
  socket: GroupSocket, operation: GroupOperation, data: Record<string, unknown>,
  current: () => boolean, signal?: AbortSignal, timeoutMs = 15_000,
): Promise<GroupOperationResult> {
  if (!socket.connected || !current()) return Promise.reject(new GroupOperationError('OFFLINE', 'Reconnect before changing group membership'));
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
  const socketId = socket.id;
  const events = { create: 'create-group', add: 'add-group-member', kick: 'kick-group-member', leave: 'leave-group' };
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: GroupOperationResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('group-operation-result', acknowledged);
      socket.off('disconnect', disconnected);
      signal?.removeEventListener('abort', cancelled);
      if (error) reject(error); else resolve(result!);
    };
    const uncertain = () => new GroupOperationError('OUTCOME_UNKNOWN', 'No server confirmation. The group may have changed; reconnect and review before retrying.');
    const acknowledged = (reply: any) => {
      if (reply?.requestId !== data.requestId || reply?.operation !== operation ||
          (operation !== 'create' && reply?.channelId !== data.channelId)) return;
      if (!current() || !socket.connected || socket.id !== socketId) { finish(uncertain()); return; }
      if (reply.ok === false) {
        finish(new GroupOperationError(typeof reply.code === 'string' ? reply.code : 'DENIED', typeof reply.error === 'string' ? reply.error : 'Group operation denied'));
      } else if (reply.ok === true && typeof reply.channelId === 'string' && membershipRevision(reply.membershipRevision) !== null &&
          ((operation === 'leave' && reply.channel === null) ||
            (validGroupSnapshot(reply.channel) && reply.channel.id === reply.channelId && reply.channel.membershipRevision === reply.membershipRevision))) {
        finish(undefined, reply);
      } else finish(uncertain());
    };
    const disconnected = () => finish(uncertain());
    const cancelled = () => finish(uncertain());
    const timer = setTimeout(() => finish(uncertain()), timeoutMs);
    socket.on('group-operation-result', acknowledged);
    socket.on('disconnect', disconnected);
    signal?.addEventListener('abort', cancelled, { once: true });
    try { socket.emit(events[operation], data); } catch { finish(uncertain()); }
  });
}
