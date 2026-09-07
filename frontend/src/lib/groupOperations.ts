import type { Socket } from 'socket.io-client';
import { getSocket } from './socketConnection';
import { groupMembership } from './groupAccess';
import { requestGroupOperation, GroupOperationError, type GroupOperation, type GroupOperationResult } from './groupOperation';

type Pending = { socket: Socket; controller: AbortController; promise: Promise<GroupOperationResult> };
const pending = new Map<string, Pending>();
// Retain uncertain creation IDs for an explicit retry; never duplicate a group
// merely because its successful server response was lost. No auto replay.
const creationRequests = new Map<string, string>();

export function cancelGroupOperations(socket: Socket): void {
  for (const entry of pending.values()) if (entry.socket === socket) entry.controller.abort();
}

export function performGroupOperation(operation: GroupOperation, data: Record<string, unknown>): Promise<GroupOperationResult> {
  const socket = getSocket();
  const realm = groupMembership.realm();
  if (!socket?.connected || !realm || !groupMembership.ready()) {
    return Promise.reject(new GroupOperationError('OFFLINE', 'Reconnect and wait for your groups to load before making changes'));
  }
  const channelId = typeof data.channelId === 'string' ? data.channelId : '';
  const expectedRevision = operation === 'create' ? undefined : groupMembership.revision(channelId);
  if (operation !== 'create' && expectedRevision === null) {
    return Promise.reject(new GroupOperationError('UNAVAILABLE', 'You no longer have access to this group'));
  }
  const key = JSON.stringify([realm, operation, data]);
  const existing = pending.get(key);
  if (existing?.socket === socket) return existing.promise;
  const requestId = operation === 'create' ? creationRequests.get(key) || crypto.randomUUID() : crypto.randomUUID();
  if (operation === 'create') {
    if (creationRequests.size >= 64 && !creationRequests.has(key)) creationRequests.delete(creationRequests.keys().next().value!);
    creationRequests.set(key, requestId);
  }
  const controller = new AbortController();
  const entry: Pending = { socket, controller, promise: undefined! };
  entry.promise = requestGroupOperation(socket, operation, { ...data, expectedRevision, requestId },
    () => getSocket() === socket && groupMembership.realm() === realm, controller.signal)
    .then(result => { creationRequests.delete(key); return result; })
    .catch(error => {
      if (!(error instanceof GroupOperationError) || error.code !== 'OUTCOME_UNKNOWN') creationRequests.delete(key);
      throw error;
    }).finally(() => { if (pending.get(key) === entry) pending.delete(key); });
  pending.set(key, entry);
  return entry.promise;
}
