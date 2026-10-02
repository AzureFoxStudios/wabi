import { beforeEach, expect, mock, test } from 'bun:test';
import { get, writable } from 'svelte/store';

let server = 'https://one.example';
let account = '1';
let generation = 0;
let token = 'one';
const fakeSocket = { on() {}, off() {}, emit() {} };
const socketStore = writable<any>(fakeSocket);
mock.module('./socketConnection', () => ({ socket: socketStore, connected: writable(true), getSocket: () => fakeSocket }));
mock.module('$lib/wabidb', () => ({ getWabiDB: () => null }));
mock.module('./api', () => ({ createChannelApi: async () => null, deleteChannelApi: async () => {} }));
mock.module('./api/channelAccess', () => ({ ensureChannelMembership: async () => {} }));
mock.module('./authSession', () => ({
  getAuthToken: () => token, getStoredDbUserId: () => account, getStoredUsername: () => account,
  authSessionGeneration: () => generation, onAuthSessionCleared: () => () => {}
}));
mock.module('./serverUrl', () => ({ getServerUrl: () => server }));
mock.module('./openingSurfacePreference', () => ({ accountPreferenceKey: (...parts: string[]) => parts.join('|') }));
mock.module('./toast', () => ({ showToast: () => {} }));
mock.module('./groupAccess', () => ({ captureGroupAccess: () => () => true, groupMembership: { acceptsContent: () => true } }));
const { channels, fetchVoicePolicy } = await import('./channelStore');
const originalFetch = globalThis.fetch;
beforeEach(() => {
  server = 'https://one.example'; account = '1'; generation += 1; token = 'one';
  // A text fixture avoids the automatic voice hydration subscription: each
  // test controls the one in-flight policy request explicitly.
  channels.set([{ id: 'voice', name: 'fixture', createdAt: 0, type: 'text' }]);
});

for (const change of ['server', 'account', 'session'] as const) {
  test(`delayed voice policy cannot cross a ${change} boundary`, async () => {
    let complete!: (response: Response) => void;
    globalThis.fetch = (() => new Promise<Response>(resolve => { complete = resolve; })) as unknown as typeof fetch;
    try {
      const pending = fetchVoicePolicy('voice');
      if (change === 'server') server = 'https://two.example';
      if (change === 'account') account = '2';
      if (change === 'session') generation += 1;
      complete(new Response(JSON.stringify({ voiceSettings: { entryMode: 'listen_only' } })));
      await pending;
      expect(get(channels)[0].voiceSettings).toBeUndefined();
    } finally { globalThis.fetch = originalFetch; }
  });
}

test('current session hydrates the Authority policy', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ voiceSettings: { entryMode: 'muted' } }))) as unknown as typeof fetch;
  try {
    await fetchVoicePolicy('voice');
    expect(get(channels)[0].voiceSettings?.entryMode).toBe('muted');
  } finally { globalThis.fetch = originalFetch; }
});
