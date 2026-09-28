import { describe, expect, mock, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { writable } from 'svelte/store';
import type { ProfileSaveSocket } from './profileSave';

// Browser dependency mocks are isolated so other suites keep their real stores.
const FIXTURE_FLAG = 'WABI_PROFILE_SAVE_FIXTURE';
if (process.env[FIXTURE_FLAG] !== '1') {
 test('profile save contract runs with isolated browser dependency mocks', () => {
  const result = Bun.spawnSync([process.execPath, 'test', fileURLToPath(import.meta.url)], { cwd: fileURLToPath(new URL('../../', import.meta.url)), env: { ...process.env, [FIXTURE_FLAG]: '1' }, stdout: 'pipe', stderr: 'pipe' });
  const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
  expect(result.exitCode, output).toBe(0);
 }, 30_000);
} else {
 class FakeSocket implements ProfileSaveSocket {
  connected = true; id = 'self-socket';
  listeners = new Map<string, Set<(payload: any) => void>>();
  emitted: Array<{ event: string; payload: any }> = [];
  emitError: Error | null = null;
  on(event: string, handler: (payload: any) => void) { if (!this.listeners.has(event)) this.listeners.set(event, new Set()); this.listeners.get(event)!.add(handler); }
  off(event: string, handler: (payload: any) => void) { this.listeners.get(event)?.delete(handler); }
  emit(event: string, payload: any) { if (this.emitError) throw this.emitError; this.emitted.push({ event, payload }); }
  deliver(event: string, payload: any = {}) { for (const handler of [...(this.listeners.get(event) || [])]) handler(payload); }
  listenerCount() { return [...this.listeners.values()].reduce((total, handlers) => total + handlers.size, 0); }
 }
 const connected = writable(true);
 const currentUser = writable<{ id: string; dbUserId: number } | null>({ id: 'user-1', dbUserId: 1 });
 let activeSocket: FakeSocket | null = null;
 mock.module('./socket', () => ({ connected, currentUser, getSocket: () => activeSocket }));
 const { requestProfileSave, saveProfilePatch } = await import('./profileSave');
 const isSelf = (payload: any) => payload.id === 'user-1' && payload.dbUserId === 1;

 describe('correlated profile acknowledgements', () => {
  test('publishing waits for the matching self receipt and removes every listener', async () => {
   const socket = new FakeSocket(); let settled = false;
   const save = requestProfileSave(socket, { bio: 'Draft' }, 'save-a', isSelf, 1000).then(() => { settled = true; });
   expect(socket.emitted).toEqual([{ event: 'update-profile', payload: { bio: 'Draft', requestId: 'save-a' } }]);
   socket.deliver('profile-updated', { id: 'user-1', dbUserId: 1, profileRequestId: 'another-save' });
   socket.deliver('profile-updated', { id: 'user-2', dbUserId: 2, profileRequestId: 'save-a' });
   socket.deliver('profile-update-failed', { profileRequestId: 'another-save', reason: 'Unrelated failure' });
   await Promise.resolve(); expect(settled).toBe(false); expect(socket.listenerCount()).toBe(3);
   socket.deliver('profile-updated', { id: 'user-1', dbUserId: 1, profileRequestId: 'save-a' });
   await save; expect(settled).toBe(true); expect(socket.listenerCount()).toBe(0);
  });
  test('concurrent requests are confirmed independently', async () => {
   const socket = new FakeSocket(); let secondDone = false;
   const first = requestProfileSave(socket, { bio: 'First' }, 'one', isSelf, 1000);
   const second = requestProfileSave(socket, { usernameFont: { preset: 'ocean' } }, 'two', isSelf, 1000).then(() => { secondDone = true; });
   socket.deliver('profile-updated', { id: 'user-1', dbUserId: 1, profileRequestId: 'one' });
   await first; expect(secondDone).toBe(false); expect(socket.listenerCount()).toBe(3);
   socket.deliver('profile-updated', { id: 'user-1', dbUserId: 1, profileRequestId: 'two' });
   await second; expect(socket.listenerCount()).toBe(0);
  });
  test('matching rejection preserves the server reason and cleans up', async () => {
   const socket = new FakeSocket(); const save = requestProfileSave(socket, { bio: 'Draft' }, 'denied', isSelf, 1000);
   const rejected = save.then(() => null, (error: Error) => error);
   socket.deliver('profile-update-failed', { profileRequestId: 'denied', reason: 'Invalid bio' });
   const error = await rejected; expect(error).toBeInstanceOf(Error); expect(error?.message).toContain('Invalid bio'); expect(socket.listenerCount()).toBe(0);
  });
  test('timeout reports an uncertain save instead of success and cleans up', async () => {
   const socket = new FakeSocket();
   await expect(requestProfileSave(socket, {}, 'timeout', isSelf, 5)).rejects.toThrow('could not be confirmed');
   expect(socket.listenerCount()).toBe(0);
  });
  test('disconnect during save rejects and removes every handler', async () => {
   const socket = new FakeSocket(); const save = requestProfileSave(socket, {}, 'disconnect', isSelf, 1000);
   const rejected = save.then(() => null, (error: Error) => error);
   socket.deliver('disconnect'); const error = await rejected; expect(error).toBeInstanceOf(Error); expect(error?.message).toContain('Disconnected before the save was confirmed'); expect(socket.listenerCount()).toBe(0);
  });
  test('synchronous emit failure rejects and cleans up', async () => {
   const socket = new FakeSocket(); socket.emitError = new Error('Transport unavailable');
   await expect(requestProfileSave(socket, {}, 'emit-failed', isSelf, 1000)).rejects.toThrow('Transport unavailable'); expect(socket.listenerCount()).toBe(0);
  });
  test('wrapper refuses publishing without a connected authenticated session', async () => {
   for (const fixture of [{ socket: null, online: true, self: true }, { socket: new FakeSocket(), online: false, self: true }, { socket: new FakeSocket(), online: true, self: false }]) {
    activeSocket = fixture.socket; connected.set(fixture.online); currentUser.set(fixture.self ? { id: 'user-1', dbUserId: 1 } : null);
    await expect(saveProfilePatch({ bio: 'Draft' })).rejects.toThrow('Connect to your server'); expect(activeSocket?.emitted.length || 0).toBe(0);
   }
   activeSocket = new FakeSocket(); activeSocket.connected = false; connected.set(true); currentUser.set({ id: 'user-1', dbUserId: 1 });
   await expect(saveProfilePatch({ bio: 'Draft' })).rejects.toThrow('Connect to your server'); expect(activeSocket.emitted.length).toBe(0);
  });
  test('wrapper creates a request ID and accepts only the stable account receipt', async () => {
   activeSocket = new FakeSocket(); connected.set(true); currentUser.set({ id: 'self-socket', dbUserId: 1 });
   const save = saveProfilePatch({ bio: '' }); const requestId = activeSocket.emitted[0].payload.requestId;
   expect(typeof requestId).toBe('string'); expect(requestId.length).toBeGreaterThan(10);
   activeSocket.deliver('profile-updated', { id: 'user-2', dbUserId: 2, profileRequestId: requestId }); expect(activeSocket.listenerCount()).toBe(3);
   activeSocket.deliver('profile-updated', { id: 'user-1', dbUserId: 1, profileRequestId: requestId }); await save; expect(activeSocket.listenerCount()).toBe(0);
  });
 });
}
