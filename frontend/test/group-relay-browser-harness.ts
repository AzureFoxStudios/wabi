// Production relay setup/teardown with real generated audio and encoders.
// HTTP/raw-WebSocket/Socket.IO are fixture boundaries; no remote server/devices.
import { get } from 'svelte/store';
import { revokeGroupCall, cleanupAllConnections } from '../src/lib/calling_impl_core';
import { connectWabidbCall, disconnectWabidbCall, getWabidbRelayDiagnostics, wabidbStartVideo, wabidbStopVideoSource, wabidbVideoTransportLive } from '../src/lib/callingWabidb';
import { localStream, listeningVoiceChannels } from '../src/lib/callingStateStores';
import { groupMembership } from '../src/lib/groupAccess';
import { setConfiguredServerUrl } from '../src/lib/serverUrl';
import { setAuthToken, setStoredDbUserId } from '../src/lib/authSession';
import { setCallTransportMode } from '../src/lib/mediaRuntime';
import { callSessionManager } from '../src/lib/callSessionManager';

function assert(value: unknown, label: string) { if (!value) throw new Error(label); }
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 250; i++) { if (check()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error(`Timed out: ${label}`);
}
class RawSocket {
  static OPEN = 1; readyState = 0;
  onopen?: () => void; onmessage?: (event: { data: string }) => void;
  constructor() { queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
  send(text: string) {
    if (JSON.parse(text).type === 'authenticate') queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({
      type: 'authenticated', user_id: 1, expires_at: Math.floor(Date.now() / 1000) + 3600
    }) }));
  }
  close() { this.readyState = 3; }
}
class FixtureSocket {
  id = 'relay-socket'; connected = true;
  holdRoom = false; roomRequests: any[] = []; sent: [string, any][] = [];
  listeners = new Map<string, Set<(data: any) => void>>();
  on(event: string, fn: (data: any) => void) { const set = this.listeners.get(event) ?? new Set(); set.add(fn); this.listeners.set(event, set); return this; }
  off(event: string, fn: (data: any) => void) { this.listeners.get(event)?.delete(fn); return this; }
  emit(event: string, data: any) {
    this.sent.push([event, data]);
    if (event === 'join-wabidb-call') {
      this.roomRequests.push(data);
      if (!this.holdRoom) queueMicrotask(() => this.receive('wabidb-call-joined', data));
    }
    return this;
  }
  receive(event: string, data: any) { for (const fn of [...this.listeners.get(event) ?? []]) fn(data); }
}
async function run() {
  const results: string[] = [];
  const originalFetch = window.fetch, OriginalWebSocket = window.WebSocket;
  const context = new AudioContext(); await context.resume();
  const oscillator = context.createOscillator(), destination = context.createMediaStreamDestination();
  oscillator.connect(destination); oscillator.start(); // no speaker connection
  const socket = new FixtureSocket();
  let revision = 1;
  const grant = () => {
    const realm = groupMembership.realm()!;
    assert(groupMembership.apply({ id: 'group-relay', type: 'group', name: 'Relay', createdAt: 0,
      ownerId: 'user-1', members: ['user-1', 'user-2'], membershipRevision: String(revision++) }, realm), 'fresh grant');
    groupMembership.finishInit(realm);
  };
  const remove = () => groupMembership.revoke('group-relay', String(revision++), groupMembership.realm()!);
  const keys = () => getWabidbRelayDiagnostics().map(row => row.key);
  const requests: { url: string; init: RequestInit }[] = [];
  let holdCreate = false, holdLeave = false;
  let releaseCreate!: () => void, releaseLeave!: () => void;
  setConfiguredServerUrl(location.origin, false);
  setAuthToken(`header.${btoa(JSON.stringify({ sub: '1', exp: 4102444800 }))}.fixture`);
  setStoredDbUserId(1); setCallTransportMode('wabidb');
  window.WebSocket = RawSocket as any;
  window.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input); requests.push({ url, init });
    const payload = init.body ? JSON.parse(String(init.body)) : null;
    if (holdCreate && payload?.channel_id === 'group-relay') {
      holdCreate = false; await new Promise<void>(resolve => { releaseCreate = resolve; });
    }
    if (holdLeave && url.includes('group-relay') && url.includes('/leave')) {
      holdLeave = false; await new Promise<void>(resolve => { releaseLeave = resolve; });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  navigator.mediaDevices.getUserMedia = async () => { throw new Error('Unexpected real microphone request'); };
  localStream.set(destination.stream);
  listeningVoiceChannels.set(['voice-canary']);
  callSessionManager.register({ id: 'voice-canary', channelId: 'voice-canary', name: 'Voice canary', kind: 'channel', direction: 'listen' });
  try {
    grant();
    await connectWabidbCall(socket as any, 'voice-canary', 'Listener', location.origin, undefined, true);
    assert(keys().includes('voice-canary'), 'unrelated real receive relay established');
    holdCreate = true;
    const old = connectWabidbCall(socket as any, 'group-relay', 'Group', location.origin).catch(error => error);
    await until(() => Boolean(releaseCreate), 'old REST create waiting');
    remove(); grant();
    await connectWabidbCall(socket as any, 'group-relay', 'New group', location.origin);
    releaseCreate(); assert((await old).name === 'AbortError', 'old REST completion cancelled');
    assert(keys().includes('group-relay') && keys().includes('voice-canary'), 'old completion preserves new and unrelated relays');
    assert(requests.filter(r => r.url.includes('group-relay') && r.url.includes('/join')).length === 1, 'retired run never dispatches a join');
    results.push('remove/re-add during REST: new relay survives old completion, unrelated relay retained');

    holdLeave = true; remove();
    await until(() => Boolean(releaseLeave), 'old HTTP leave waiting');
    const leaving = requests.findLast(r => r.url.includes('group-relay') && r.url.includes('/leave'))!;
    assert(leaving.url.endsWith('?membership_revision=3'), 'leave retains removed membership revision');
    assert(!keys().includes('group-relay') && keys().includes('voice-canary'), 'local relay revoked before leave acknowledgement');
    grant(); await connectWabidbCall(socket as any, 'group-relay', 'Again', location.origin);
    releaseLeave(); await tick();
    assert(keys().includes('group-relay') && keys().includes('voice-canary'), 'late leave cannot delete replacement session/relay');
    results.push('delayed HTTP leave: immediate local revocation, revision pinned, replacement survives');

    remove(); grant();
    socket.holdRoom = true;
    const before = socket.roomRequests.length;
    const pendingRoom = connectWabidbCall(socket as any, 'group-relay', 'Pending room', location.origin).catch(error => error);
    await until(() => socket.roomRequests.length > before, 'pending relay room admission');
    const staleRoom = socket.roomRequests.at(-1);
    remove(); grant(); socket.holdRoom = false;
    await connectWabidbCall(socket as any, 'group-relay', 'Fresh room', location.origin);
    socket.receive('wabidb-call-joined', staleRoom);
    assert(await pendingRoom instanceof Error, 'cancelled room cannot succeed on late ACK');
    assert(keys().includes('group-relay') && keys().includes('voice-canary'), 'stale room catch cannot stop new/other relay');
    assert(get(localStream) === destination.stream && destination.stream.getAudioTracks()[0].readyState === 'live', 'shared capture preserved');
    results.push('remove/re-add during relay room admission: stale ACK/catch cannot revive or tear down replacement');

    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
	const encoder = (window as any).VideoEncoder;
	try {
		(window as any).VideoEncoder = undefined;
		assert(!wabidbVideoTransportLive('group-relay') && keys().includes('group-relay'), 'webview without WebCodecs selects P2P video without stopping relay audio');
	} finally { (window as any).VideoEncoder = encoder; }
    const ctx = canvas.getContext('2d')!;
    let frame = 0;
    const paint = window.setInterval(() => { ctx.fillStyle = frame++ % 2 ? '#f00' : '#00f'; ctx.fillRect(0, 0, 64, 64); }, 30);
    try {
      const screen = canvas.captureStream(15);
      assert(await wabidbStartVideo('screen', screen, 'group-relay'), 'group video encoder starts alongside a background relay');
      await until(() => socket.sent.some(([event, data]) => event === 'wabidb-media' && data.kind === 'video'), 'real encoded video envelopes');
      assert(socket.sent.filter(([event, data]) => event === 'wabidb-media' && data.kind === 'video').every(([, data]) => data.sessionId === 'channel:group-relay'), 'video uses explicit group lane, not first connected background relay');
      remove();
      const afterRemoval = socket.sent.filter(([event, data]) => event === 'wabidb-media' && data.kind === 'video').length;
      await new Promise(resolve => setTimeout(resolve, 150));
      assert(screen.getTracks().every(track => track.readyState === 'ended'), 'revocation stops real encoder source');
      assert(socket.sent.filter(([event, data]) => event === 'wabidb-media' && data.kind === 'video').length === afterRemoval, 'retired lane emits no late video');
      assert(keys().includes('voice-canary') && destination.stream.getAudioTracks()[0].readyState === 'live', 'video teardown preserves background relay and shared mic');
      grant(); await connectWabidbCall(socket as any, 'group-relay', 'Replacement', location.origin);
      const next = canvas.captureStream(15);
      assert(await wabidbStartVideo('screen', next, 'group-relay'), 're-added group gets a fresh encoder');
      wabidbStopVideoSource('screen', 'voice-canary');
      assert(next.getTracks()[0].readyState === 'live', 'other session stop cannot stop new screen');
      wabidbStopVideoSource('screen', 'group-relay');
      assert(next.getTracks()[0].readyState === 'ended', 'explicit stop retires owned source');
      results.push('real video encoding: exact session routing, no post-revocation envelopes, independent background relay, fresh re-add');
    } finally { clearInterval(paint); }
    return results;
  } finally {
    revokeGroupCall('group-relay'); await disconnectWabidbCall(); cleanupAllConnections(); callSessionManager.leaveAll();
    destination.stream.getTracks().forEach(track => track.stop()); oscillator.stop(); await context.close();
    window.fetch = originalFetch; window.WebSocket = OriginalWebSocket; setAuthToken(null);
  }
}
(window as any).__audioSmoke = { status: 'ready' };
document.querySelector('#run')!.addEventListener('click', () => {
  (window as any).__audioSmoke = { status: 'running' };
  void run().then(results => { (window as any).__audioSmoke = { status: 'passed', results }; },
    error => { (window as any).__audioSmoke = { status: 'failed', error: String(error), stack: error?.stack }; });
});
