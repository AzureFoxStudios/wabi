import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

let token: string | null = 'synthetic-account';
let base = 'https://synthetic.invalid';
mock.module('$app/environment', () => ({ browser: true }));
mock.module('$lib/authSession', () => ({ getAuthToken: () => token }));
mock.module('$lib/api/utils', () => ({ getApiBase: () => base }));
const { subscribeWebPush } = await import('./pushClient');
const syntheticKey = btoa(String.fromCharCode(4) + '\0'.repeat(64)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const saved = new Map<string, PropertyDescriptor | undefined>();
let calls: string[], subscribe: ReturnType<typeof mock>, permission: ReturnType<typeof mock>;
let manager: { getSubscription: () => Promise<PushSubscription | null>; subscribe: ReturnType<typeof mock> };
let registration: { pushManager: typeof manager };
function globalValue(name: string, value: unknown) {
    if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
beforeEach(() => {
    token = 'synthetic-account'; base = 'https://synthetic.invalid'; calls = [];
    subscribe = mock(async () => ({ endpoint: 'https://synthetic-push.invalid', toJSON: () => ({ endpoint: 'https://synthetic-push.invalid', keys: {} }) }) as PushSubscription);
    permission = mock(async () => 'granted');
    manager = { getSubscription: async () => null, subscribe };
    registration = { pushManager: manager };
    globalValue('window', { isSecureContext: true, PushManager: {}, Notification: {} });
    globalValue('Notification', { permission: 'granted', requestPermission: permission });
    globalValue('navigator', { userAgent: 'synthetic-test', serviceWorker: { ready: Promise.resolve(registration) } });
    globalValue('fetch', mock(async (url: string) => {
        calls.push(url);
        return url.endsWith('vapid-public-key') ? Response.json({ publicKey: syntheticKey }) : Response.json({ ok: true });
    }));
});
afterEach(() => {
    for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    }
    saved.clear();
});
test('requires sign-in before any device permission or subscription action', async () => {
    token = null;
    expect(await subscribeWebPush()).toEqual({ ok: false, reason: 'not_authenticated' });
    expect(permission).not.toHaveBeenCalled(); expect(subscribe).not.toHaveBeenCalled(); expect(calls).toEqual([]);
});
test('reports endpoint HTTP refusal before browser registration', async () => {
    globalValue('fetch', mock(async () => new Response('private diagnostic', { status: 403 })));
    expect(await subscribeWebPush()).toEqual({ ok: false, reason: 'vapid_http_403' });
    expect(subscribe).not.toHaveBeenCalled();
});
test('refuses account switch during service worker wait without using either account', async () => {
    let release!: (value: typeof registration) => void;
    globalValue('navigator', { serviceWorker: { ready: new Promise(resolve => release = resolve) } });
    const pending = subscribeWebPush(); token = 'other-account'; release(registration);
    expect(await pending).toEqual({ ok: false, reason: 'account_changed' });
    expect(subscribe).not.toHaveBeenCalled(); expect(calls).toEqual([]);
});
test('refuses server switch during public-key response before device registration', async () => {
    globalValue('fetch', mock(async () => { base = 'https://other.invalid'; return Response.json({ publicKey: syntheticKey }); }));
    expect(await subscribeWebPush()).toEqual({ ok: false, reason: 'account_changed' });
    expect(subscribe).not.toHaveBeenCalled();
});
test('does not upload under a changed account after browser registration', async () => {
    subscribe.mockImplementation(async () => { token = 'other-account'; return { endpoint: 'synthetic', toJSON: () => ({ endpoint: 'synthetic' }) } as PushSubscription; });
    expect(await subscribeWebPush()).toEqual({ ok: false, reason: 'account_changed' });
    expect(calls).toHaveLength(1);
});
test('reports browser permission refusal as device failure', async () => {
    subscribe.mockImplementation(async () => { throw new DOMException('sensitive vendor diagnostic', 'NotAllowedError'); });
    expect(await subscribeWebPush()).toEqual({ ok: false, reason: 'browser_subscription_denied' });
    expect(calls).toHaveLength(1);
});
test('reports registration key conflict without hiding it as missing VAPID', async () => {
    subscribe.mockImplementation(async () => { throw new DOMException('sensitive key detail', 'InvalidStateError'); });
    expect(await subscribeWebPush()).toEqual({ ok: false, reason: 'browser_subscription_conflict' });
});
test('server subscription refusal exposes status without raw operator response', async () => {
    globalValue('fetch', mock(async (url: string) => url.endsWith('vapid-public-key') ? Response.json({ publicKey: syntheticKey }) : new Response('private diagnostic', { status: 500 })));
    expect(await subscribeWebPush()).toEqual({ ok: false, reason: 'subscription_http_500' });
});
test('server persistence network failure is not reported as successful registration', async () => {
    globalValue('fetch', mock(async (url: string) => { if (url.endsWith('vapid-public-key')) return Response.json({ publicKey: syntheticKey }); throw new Error('offline'); }));
    expect(await subscribeWebPush()).toEqual({ ok: false, reason: 'subscription_network_error' });
});
test('registers with current server after synthetic device subscription', async () => {
    expect(await subscribeWebPush()).toEqual({ ok: true, endpoint: 'https://synthetic-push.invalid' });
    expect(calls).toEqual(['https://synthetic.invalid/api/push/vapid-public-key', 'https://synthetic.invalid/api/push/subscribe']);
});
test('an expired access token is renewed once and the subscription retried', async () => {
    let status = 401;
    const postTokens: string[] = [];
    globalValue('fetch', mock(async (url: string, init?: RequestInit) => {
        calls.push(url);
        if (url.endsWith('vapid-public-key')) return Response.json({ publicKey: syntheticKey });
        postTokens.push(String((init?.headers as Record<string, string>).Authorization));
        const response = Response.json({ ok: true }, { status });
        status = 200;
        return response;
    }));
    mock.module('$lib/api/authRefresh', () => ({ tryRefresh: async () => { token = 'renewed-account'; return true; } }));
    expect(await subscribeWebPush()).toEqual({ ok: true, endpoint: 'https://synthetic-push.invalid' });
    expect(postTokens).toEqual(['Bearer synthetic-account', 'Bearer renewed-account']);
});
