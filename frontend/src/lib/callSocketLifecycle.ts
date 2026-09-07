import type { Socket } from 'socket.io-client';

type Owner = {
  disconnected(socket: Socket): void;
  initialized(socket: Socket): Promise<void> | void;
};
const owners = new Set<Owner>();

/** No calling-module import here: owners register when loaded. SocketManager
 * must notify BEFORE removing listeners, including explicit socket replacement.
 * A transport connect is not authoritative init and must not readmit calls. */
export function registerCallSocketOwner(owner: Owner): () => void {
  owners.add(owner);
  return () => { owners.delete(owner); };
}

export function callSocketDisconnected(socket: Socket): void {
  for (const owner of owners) {
    try { owner.disconnected(socket); }
    catch (error) { console.error('[Calling] Socket retirement failed:', error); }
  }
}

export async function callSocketInitialized(socket: Socket): Promise<void> {
  await Promise.all([...owners].map(async owner => {
    try { await owner.initialized(socket); }
    catch (error) { console.error('[Calling] Socket readmission failed:', error); }
  }));
}
