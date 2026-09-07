import { describe, expect, test } from 'bun:test';
import { WabiDbCallState } from './wabidbCallConnection';

class FakeWs {
  readyState = 0;
  onopen?: () => void;
  onclose?: (event: { code: number }) => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  sent: any[] = [];
  send(text: string) { this.sent.push(JSON.parse(text)); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(message: any) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.readyState = 3; }
  closed(code = 1006) { this.close(); this.onclose?.({ code }); }
  acknowledge(user = 1) { this.receive({ type: 'authenticated', user_id: user, expires_at: Math.floor(Date.now() / 1000) + 3600 }); }
}
const access = (user = 1, version = 1) => `header.${btoa(JSON.stringify({ sub: String(user), version }))}.signature`;
const tick = () => new Promise<void>(r => setTimeout(r, 0));
function setup() {
  let token: string | null = access();
  const sockets: FakeWs[] = [];
  let refreshes = 0;
  const requests: [string, RequestInit][] = [];
  let respond = async () => new Response('{}', { status: 200 });
  let refresh = async () => { token = access(1, 2); return true; };
  const client = new WabiDbCallState({ serverUrl: 'https://one.example' }, {
    getToken: () => token,
    refresh: async () => { refreshes++; return refresh(); },
    socket: () => { const socket = new FakeWs(); sockets.push(socket); return socket as any; },
    fetch: (async (url: string, init: RequestInit) => { requests.push([url, init]); return respond(); }) as any
  });
  return { client, sockets, requests, get refreshes() { return refreshes; }, setToken(value: string | null) { token = value; },
    setRefresh(fn: typeof refresh) { refresh = fn; }, setResponse(fn: typeof respond) { respond = fn; } };
}

describe('authenticated call-state lifecycle', () => {
  test('call writes pin the membership revision across refresh; cancellation prevents a retry', async () => {
    const fixture = setup();
    let attempts = 0;
    fixture.setResponse(async () => new Response('{}', { status: ++attempts === 1 ? 401 : 200 }));
    await fixture.client.joinSession('channel:group', 1, 'user-1', { membershipRevision: '9007199254740993' });
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests.every(([url]) => url.endsWith('?membership_revision=9007199254740993'))).toBe(true);
    const controller = new AbortController();
    fixture.setResponse(async () => { controller.abort(); return new Response('{}', { status: 401 }); });
    const failure = await fixture.client.createSession('channel:group', 'group', 'audio-call', 1, 10,
      { membershipRevision: '9007199254740993', signal: controller.signal }).catch(error => error);
    expect(failure.name).toBe('AbortError');
    expect(fixture.requests).toHaveLength(3); expect(fixture.refreshes).toBe(1);
    fixture.client.disconnect();
  });
  test('revocation retires cached rows and subscription handles, preserving unrelated sessions', async () => {
    const { client, sockets } = setup();
    const [old] = client.subscribeToSession('channel:group');
    client.subscribeToSession('channel:voice');
    let sessions: any[] = [];
    client.onSessionChange(rows => { sessions = rows; });
    const pending = client.requestConnect(); sockets[0].open(); sockets[0].acknowledge(); await pending;
    const snapshot = (id: string, revision: string) => ({ type: 'call_snapshot', session_id: id, membership_revision: revision,
      session: { session_id: id, channel_id: id, started_at_micros: 1, max_participants: 10 }, participants: [], signals: [] });
    sockets[0].receive(snapshot('channel:group', '9007199254740993'));
    sockets[0].receive(snapshot('channel:voice', '0'));
    client.revokeSession('channel:group');
    sockets[0].receive(snapshot('channel:group', '9007199254740993'));
    expect(sessions.map(row => row.sessionId)).toEqual(['channel:voice']);
    client.subscribeToSession('channel:group'); old.unsubscribe();
    sockets[0].receive(snapshot('channel:group', '9007199254740995'));
    sockets[0].receive({ type: 'subscription_error', session_id: 'channel:group', membership_revision: '9007199254740994' });
    expect(sessions).toHaveLength(2);
    sockets[0].receive({ type: 'subscription_error', session_id: 'channel:group', membership_revision: '9007199254740996' });
    expect(sessions.map(row => row.sessionId)).toEqual(['channel:voice']);
    const before = sockets[0].sent.length;
    sockets[0].receive({ type: 'resync_required' });
    expect(sockets[0].sent.slice(before).map(message => message.session_id)).toEqual(['channel:voice']);
    client.disconnect();
  });
  test('TCP open cannot resolve either overlapping handshake; auth ACK resolves both', async () => {
    const { client, sockets } = setup();
    let resolved = 0;
    const a = client.requestConnect().then(() => resolved++);
    const b = client.requestConnect().then(() => resolved++);
    expect(sockets).toHaveLength(1);
    sockets[0].open(); await tick();
    expect(resolved).toBe(0); expect(client.isConnected).toBe(false);
    expect(sockets[0].sent).toEqual([{ type: 'authenticate', token: access() }]);
    sockets[0].acknowledge(); await Promise.all([a, b]);
    expect(resolved).toBe(2); expect(client.isConnected).toBe(true);
    client.disconnect();
  });

  test('auth rejection refreshes once, preserves waiters, and ignores retired callbacks', async () => {
    const fixture = setup(); const { client, sockets } = fixture;
    const pending = client.requestConnect(); sockets[0].open(); sockets[0].closed(4401);
    await tick(); expect(fixture.refreshes).toBe(1); expect(sockets).toHaveLength(2);
    sockets[1].open(); expect(sockets[1].sent[0].token).toBe(access(1, 2));
    sockets[1].acknowledge(); await pending;
    sockets[0].closed(); sockets[0].receive({ type: 'authenticated', user_id: 99, expires_at: 0 });
    expect(client.isConnected).toBe(true);
    client.disconnect();
  });

  test('rejected replacement credentials do not create an infinite reconnect loop', async () => {
    const fixture = setup(); const { client, sockets } = fixture;
    const pending = client.requestConnect().then(() => false, () => true);
    sockets[0].open(); sockets[0].closed(4401); await tick();
    sockets[1].open(); sockets[1].closed(4401); expect(await pending).toBe(true);
    expect(fixture.refreshes).toBe(1); expect(client.isConnected).toBe(false);
    client.disconnect();
  });

  test('disconnect settles waiters and an in-flight refresh cannot resurrect the socket', async () => {
    const fixture = setup(); let finish!: (value: boolean) => void;
    fixture.setRefresh(() => new Promise(r => finish = r));
    const pending = fixture.client.requestConnect().then(() => false, () => true);
    fixture.sockets[0].open(); fixture.sockets[0].closed(4401); await tick();
    fixture.client.disconnect(); expect(await pending).toBe(true); finish(true); await tick();
    expect(fixture.sockets).toHaveLength(1); expect(fixture.client.isConnected).toBe(false);
  });

  test('HTTP retry uses the live token; logout and account switches never revive captured credentials', async () => {
    const fixture = setup(); let n = 0;
    fixture.setResponse(async () => new Response('{}', { status: ++n === 1 ? 401 : 200 }));
    await fixture.client.createSession('channel:one', 'one', 'audio-call', 1);
    expect(fixture.refreshes).toBe(1);
    expect(new Headers(fixture.requests[0][1].headers).get('authorization')).toBe(`Bearer ${access()}`);
    expect(new Headers(fixture.requests[1][1].headers).get('authorization')).toBe(`Bearer ${access(1, 2)}`);
    fixture.setToken(null);
    await expect(fixture.client.createSession('channel:one', 'one', 'audio-call', 1)).rejects.toThrow('authentication lost');
    fixture.setToken(access(2));
    await expect(fixture.client.createSession('channel:one', 'one', 'audio-call', 1)).rejects.toThrow('account changed');
    expect(fixture.requests).toHaveLength(2); fixture.client.disconnect();
  });

  test('subscriptions are reference counted, stale handles cannot unsubscribe replacements', async () => {
    const { client, sockets } = setup(); const pending = client.requestConnect();
    const [old] = client.subscribeToSession('channel:one');
    const [second] = client.subscribeToSession('channel:one');
    sockets[0].open(); expect(sockets[0].sent).toHaveLength(1);
    sockets[0].acknowledge(); await pending;
    expect(sockets[0].sent.filter(m => m.type === 'subscribe_call')).toHaveLength(1);
    old.unsubscribe(); old.unsubscribe();
    expect(sockets[0].sent.filter(m => m.type === 'unsubscribe_call')).toHaveLength(0);
    client.unsubscribeAll(); client.subscribeToSession('channel:one'); second.unsubscribe();
    expect(sockets[0].sent.filter(m => m.type === 'unsubscribe_call')).toHaveLength(1);
    client.disconnect();
  });

  test('snapshot replay deduplicates queued signals and resync uses the durable cursor', async () => {
    const { client, sockets } = setup(); const seen: number[] = [];
    client.onSignal(s => seen.push(s.signalId)); client.subscribeToSession('channel:one');
    const pending = client.requestConnect(); sockets[0].open(); sockets[0].acknowledge(); await pending;
    const signal = { signal_id: 7, session_id: 'channel:one', from_user_id: 1, target_user_id: null, payload: 'x', created_at_micros: 1, signal_type: 'ice' };
    sockets[0].receive({ type: 'call_signal_emitted', signal });
    sockets[0].receive({ type: 'call_signal_emitted', signal });
    sockets[0].receive({ type: 'call_signal_emitted', signal: { ...signal, session_id: 'not-subscribed', signal_id: 99 } });
    expect(seen).toEqual([7]);
    sockets[0].receive({ type: 'resync_required' });
    expect(sockets[0].sent.at(-1)).toEqual({ type: 'subscribe_call', session_id: 'channel:one', since: 7 });
    client.disconnect();
  });
});
