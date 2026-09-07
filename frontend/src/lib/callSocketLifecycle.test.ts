import { expect, test } from 'bun:test';
import { registerCallSocketOwner, callSocketDisconnected, callSocketInitialized } from './callSocketLifecycle';

test('socket retirement is synchronous before listener disposal; init awaits owners', async () => {
  const sock = { id: 'old' } as any;
  const calls: string[] = [];
  let finish!: () => void;
  const unregister = registerCallSocketOwner({
    disconnected: socket => { expect(socket).toBe(sock); calls.push('retired'); },
    initialized: async () => { calls.push('readmitting'); await new Promise<void>(r => { finish = r; }); calls.push('admitted'); }
  });
  try {
    callSocketDisconnected(sock);
    calls.push('listeners removed');
    expect(calls).toEqual(['retired', 'listeners removed']);
    const initialized = callSocketInitialized({ id: 'new' } as any);
    expect(calls.at(-1)).toBe('readmitting');
    finish(); await initialized;
    expect(calls.at(-1)).toBe('admitted');
  } finally { unregister(); }
  callSocketDisconnected(sock);
  expect(calls.at(-1)).toBe('admitted');
});
