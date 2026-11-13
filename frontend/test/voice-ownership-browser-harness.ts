// Real call owners, microphone graph, relays and RTCPeerConnections. Only the
// server and permission picker are fixtures; no host devices or live accounts.
import { get } from 'svelte/store';
import { startGroupCall, joinVoiceChannel, leaveVoiceChannel, revokeGroupCall,
  handleForcedVoiceMove, handleForcedVoiceLeave, cleanupAllConnections,
  startScreenShare } from '../src/lib/calling_impl_core';
import { callSocketDisconnected, callSocketInitialized } from '../src/lib/callSocketLifecycle';
import { getWabidbRelayDiagnostics, disconnectWabidbCall } from '../src/lib/callingWabidb';
import { localStream, localScreenStream, isSharing, activeGroupCall, activeVoiceChannel, isInCall, isMuted, voiceChannelNotice, callOfflineNotice } from '../src/lib/callingStateStores';
import { groupMembership } from '../src/lib/groupAccess';
import { setConfiguredServerUrl } from '../src/lib/serverUrl';
import { setAuthToken, setStoredDbUserId } from '../src/lib/authSession';
import { setAudioProcessingMode, setCallTransportMode } from '../src/lib/mediaRuntime';
import { callSessionManager } from '../src/lib/callSessionManager';
import { voiceChannelMembers } from '../src/lib/presenceStore';

function assert(value: unknown, label: string) { if (!value) throw new Error(label); }
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
  connected = true;
  held = new Set<string>(); denied = new Set<string>(); relayDenied = new Set<string>();
  sent: [string, any][] = [];
  listeners = new Map<string, Set<(data: any) => void>>();
  constructor(public id: string) {}
  on(event: string, fn: (data: any) => void) { const set = this.listeners.get(event) ?? new Set(); set.add(fn); this.listeners.set(event, set); return this; }
  off(event: string, fn: (data: any) => void) { this.listeners.get(event)?.delete(fn); return this; }
  emit(event: string, data: any) {
    this.sent.push([event, data]);
    if (event === 'join-wabidb-call') queueMicrotask(() => this.relayDenied.has(data.channelId)
      ? this.receive('wabidb-call-denied', { ...data, reason: 'Fixture relay denied' })
      : this.receive('wabidb-call-joined', data));
    if (event === 'call-initiate') queueMicrotask(() => this.receive('group-call-started', { ...data, established: true }));
    if (event === 'start-screen-share') queueMicrotask(() => this.receive('screen-share-targets', { ...data, targets: [] }));
    if ((event === 'voice-channel-join' || event === 'voice-channel-subscribe') && !this.held.has(data.channelId)) {
      queueMicrotask(() => this.receive(this.denied.has(data.channelId) ? 'voice-channel-error' : 'voice-channel-admitted',
        { ...data, error: 'Fixture admission denied' }));
    }
    return this;
  }
  receive(event: string, data: any) { for (const fn of [...this.listeners.get(event) ?? []]) fn(data); }
  request(channel: string) { return this.sent.findLast(([event, data]) => event.startsWith('voice-channel-') && data.channelId === channel && data.requestId)?.[1]; }
  retire() { callSocketDisconnected(this as any); this.listeners.clear(); this.connected = false; groupMembership.beginConnection(); }
}

async function run() {
  const results: string[] = []; (window as any).__audioSmoke.results = results;
  const originalFetch = window.fetch, OriginalWebSocket = window.WebSocket;
  const originalCapture = navigator.mediaDevices.getUserMedia;
  const originalDisplay = navigator.mediaDevices.getDisplayMedia;
  const originalOffer = RTCPeerConnection.prototype.createOffer;
  const context = new AudioContext(); await context.resume();
  const oscillator = context.createOscillator(); oscillator.start();
  const sources: MediaStream[] = [];
  const makeStream = () => { const node = context.createMediaStreamDestination(); oscillator.connect(node); sources.push(node.stream); return node.stream; };
  const relays = () => getWabidbRelayDiagnostics().map(row => row.key);
  let captures = 0, holdCapture = false, failCapture = false, finishCapture: ((stream: MediaStream) => void) | undefined;
  let holdLeave = false;
  let painter: ReturnType<typeof setInterval> | undefined;
  const heldLeaves: (() => void)[] = [];
  setConfiguredServerUrl(location.origin, false);
  setAuthToken(`header.${btoa(JSON.stringify({ sub: '1', exp: 4102444800 }))}.fixture`);
  setStoredDbUserId(1); setAudioProcessingMode('studio'); setCallTransportMode('wabidb');
  window.WebSocket = RawSocket as any;
  window.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (holdLeave && url.includes('/leave')) await new Promise<void>(resolve => heldLeaves.push(resolve));
    const channel = url.match(/\/api\/channels\/([^/]+)\/join/);
    return new Response(JSON.stringify(channel ? { joined: true, channelId: channel[1] } : {}), { status: 200 });
  }) as typeof fetch;
  navigator.mediaDevices.getUserMedia = async () => {
    captures++;
    if (failCapture) { failCapture = false; throw new DOMException('Fixture microphone denied', 'NotAllowedError'); }
    return holdCapture ? new Promise<MediaStream>(resolve => { finishCapture = resolve; }) : makeStream();
  };
  const init = () => {
    const realm = groupMembership.realm()!;
    groupMembership.apply({ id: 'group-canary', name: 'Canary', type: 'group', createdAt: 0,
      ownerId: 'user-1', members: ['user-1', 'user-2'], membershipRevision: '1' }, realm);
    groupMembership.finishInit(realm);
  };
  let current = new FixtureSocket('original');
  try {
    init();
    await joinVoiceChannel(current as any, 'voice-a');
    await startGroupCall(current as any, 'group-canary', 'Canary');
    const stream = get(localStream);
    callSessionManager.setFocus('voice-a'); callSessionManager.setVolume('voice-a', 37);
    callSessionManager.setSessionMuted('voice-a', true); isMuted.set(true);
    holdLeave = true; current.held.add('voice-b');
    const firstMove = handleForcedVoiceMove(current as any, 'voice-a', 'voice-b');
    const firstResult = firstMove.then(() => 'success', error => error.name);
    assert(!relays().includes('voice-a') && !callSessionManager.get('voice-a'), 'source media and model retire synchronously');
    await until(() => !!current.request('voice-b'), 'move proceeds without waiting for old HTTP leave');
    assert(heldLeaves.length > 0 && callSessionManager.get('voice-b')?.lifecycle === 'reconnecting', 'pending move is honest while old leave is held');
    assert(!relays().includes('voice-b'), 'destination media waits for admission');
    await handleForcedVoiceMove(current as any, 'voice-b', 'voice-c');
    current.receive('voice-channel-admitted', current.request('voice-b'));
    assert(await firstResult === 'AbortError', 'newer move cancels old admission');
    assert(relays().includes('voice-c') && !relays().includes('voice-b'), 'late move ACK cannot resurrect intermediate destination');
    assert(get(activeVoiceChannel)?.id === 'voice-c', 'primary ownership follows chained moves');
    const moved = callSessionManager.get('voice-c');
    assert(moved?.focus === 'focused' && moved.volume === 37 && moved.muted && get(isMuted), 'move preserves focus, volume and mute');
    assert(get(localStream) === stream && relays().includes('group-canary'), 'move preserves group and shared capture');
    holdLeave = false; heldLeaves.splice(0).forEach(resolve => resolve());
    const original = current; original.retire(); init(); current = new FixtureSocket('replacement');
    await callSocketInitialized(current as any);
    assert(relays().includes('voice-c') && relays().includes('group-canary'), 'moved destination recovers on a replacement socket');
    await handleForcedVoiceLeave(original as any, 'voice-c');
    assert(relays().includes('voice-c'), 'stale old-socket kick cannot terminate replacement');
    results.push('chained moves: source retires before HTTP leave, admission fences media, late ACK is inert, controls and reconnect ownership transfer');

    current.denied.add('voice-denied');
    const denied = await handleForcedVoiceMove(current as any, 'voice-c', 'voice-denied').then(() => false, () => true);
    assert(denied && !callSessionManager.get('voice-denied') && !get(activeVoiceChannel), 'denied move removes its intent and reports failure');
    assert(get(voiceChannelNotice)?.text.includes('failed') && !get(voiceChannelNotice)?.text.startsWith('Moved'), 'denial cannot show moved success');
    assert(relays().includes('group-canary') && get(activeGroupCall) && get(localStream) === stream, 'denied voice move preserves unrelated group');
    await joinVoiceChannel(current as any, 'voice-kicked', { listenOnly: true });
    await handleForcedVoiceLeave(current as any, 'voice-kicked');
    assert(!relays().includes('voice-kicked') && relays().includes('group-canary') && get(localStream) === stream, 'forced kick tears down only its relay and capture consumer');
    revokeGroupCall('group-canary');
    assert(!get(localStream) && stream!.getAudioTracks().every(track => track.readyState === 'ended'), 'last consumer releases microphone');
    results.push('denied move and forced kick: no fake success, scoped teardown preserves group, last consumer releases microphone');

    await joinVoiceChannel(current as any, 'voice-recapture');
    get(localStream)!.getAudioTracks().forEach(track => track.stop());
    const beforeRecapture = captures;
    current.retire(); init(); current = new FixtureSocket('recapture'); current.held.add('voice-recapture');
    const recovering = callSocketInitialized(current as any);
    await until(() => !!current.request('voice-recapture'), 'recapture admission');
    assert(captures === beforeRecapture, 'ended microphone is not reacquired before admission');
    current.receive('voice-channel-admitted', current.request('voice-recapture')); await recovering;
    assert(captures === beforeRecapture + 1 && get(localStream)!.getAudioTracks()[0].readyState === 'live', 'admitted recovery replaces ended capture');
    get(localStream)!.getAudioTracks().forEach(track => track.stop());
    current.retire(); init(); current = new FixtureSocket('pending-permission'); holdCapture = true;
    const permissionRecovery = callSocketInitialized(current as any);
    await until(() => !!finishCapture, 'recovery permission pending');
    await handleForcedVoiceLeave(current as any, 'voice-recapture');
    assert(!get(localStream) && !get(isInCall), 'last kick cancels pending capture immediately');
    const late = makeStream(); finishCapture!(late); await permissionRecovery;
    await until(() => late.getTracks().every(track => track.readyState === 'ended'), 'late permission result disposed');
    assert(!get(localStream) && relays().length === 0, 'late permission cannot revive kicked call');
    results.push('ended capture: fresh admission before reacquisition, kick during permission releases late tracks and cannot revive media');

    finishCapture = undefined;
    const joining = joinVoiceChannel(current as any, 'voice-pending');
    const initialResult = joining.then(() => 'success', error => error.name);
    await until(() => !!finishCapture, 'initial permission pending');
    const pendingMove = handleForcedVoiceMove(current as any, 'voice-pending', 'voice-arrived');
    await until(() => !!current.request('voice-arrived'), 'pending primary move admitted');
    holdCapture = false; finishCapture!(makeStream()); await pendingMove;
    assert(await initialResult === 'AbortError', 'retired initial attempt rejects without erasing destination');
    assert(get(activeVoiceChannel)?.id === 'voice-arrived' && relays().includes('voice-arrived'), 'pending initial move retains primary role and shared permission');
    await handleForcedVoiceLeave(current as any, 'voice-arrived');
    assert(!get(localStream), 'last moved initial session kick releases capture');
    results.push('move during initial microphone permission: primary role transfers and retired join cleanup cannot erase destination');

    // Community voice is relay/SFU only: the client refuses direct P2P because
    // the Authority cannot enforce server mute/deafen on browser-to-browser RTP
    // (callingFallback.effectiveChain, 22e1fa59). Moves and kicks are proved on
    // the WabiDB relay, the transport community voice actually uses.
    await joinVoiceChannel(current as any, 'relay-source');
    await joinVoiceChannel(current as any, 'relay-canary', { listenOnly: true });
    assert(relays().includes('relay-source') && relays().includes('relay-canary'), 'source and canary each own a real relay');
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
    // The relay encodes real frames: keep the synthetic screen painting.
    const paint = canvas.getContext('2d')!; let frame = 0;
    painter = setInterval(() => { paint.fillStyle = frame++ % 2 ? '#000' : '#fff'; paint.fillRect(0, 0, 16, 16); }, 33);
    const screen = canvas.captureStream(30); sources.push(screen);
    navigator.mediaDevices.getDisplayMedia = async () => screen;
    assert(await startScreenShare(current as any) === screen && get(isSharing), 'source owns real screen capture');
    current.held.add('relay-destination');
    const relayMove = handleForcedVoiceMove(current as any, 'relay-source', 'relay-destination');
    assert(!relays().includes('relay-source') && relays().includes('relay-canary'), 'move retires only the source relay');
    assert(!get(localScreenStream) && !get(isSharing) && screen.getTracks().every(track => track.readyState === 'ended'), 'move stops source screen sharing');
    await until(() => !!current.request('relay-destination'), 'relay destination admission requested');
    assert(!relays().includes('relay-destination') && callSessionManager.get('relay-destination')?.lifecycle !== 'connected', 'unadmitted destination never claims connected media');
    current.receive('voice-channel-admitted', current.request('relay-destination')); await relayMove;
    assert(relays().includes('relay-destination') && callSessionManager.get('relay-destination')?.lifecycle === 'connected', 'admitted destination connects its own relay');
    await handleForcedVoiceLeave(current as any, 'relay-destination');
    assert(!relays().includes('relay-destination') && relays().includes('relay-canary') && get(localStream), 'kick removes exactly the destination relay and retains other capture consumer');
    await handleForcedVoiceLeave(current as any, 'relay-canary');
    assert(relays().length === 0 && !get(localStream), 'last relay kick closes remaining relay and microphone');
    results.push('relay moves and kicks: source screen/relay retired, unrelated relay survives, unadmitted destination never claims connected media');

    let offers = 0;
    RTCPeerConnection.prototype.createOffer = function(...args: any[]): any { offers++; return originalOffer.apply(this, args as any); };
    voiceChannelMembers.update(roster => ({ ...roster, 'p2p-refused': [{ userId: 'mesh-peer', username: 'Mesh',
      isSpeaking: false, isMuted: false, isDeafened: false }] }));
    setCallTransportMode('p2p-only');
    const refusal = await joinVoiceChannel(current as any, 'p2p-refused').then(() => '', error => String(error?.message ?? error));
    setCallTransportMode('wabidb');
    RTCPeerConnection.prototype.createOffer = originalOffer;
    assert(refusal.includes('Direct P2P is unavailable for community voice') && get(callOfflineNotice)?.includes('mute/deafen'), 'P2P-only community voice join is refused with its reason');
    assert(offers === 0 && relays().length === 0 && !callSessionManager.get('p2p-refused') && !get(activeVoiceChannel) && !get(isInCall) && !get(localStream),
      'refused P2P join creates no peer offer, relay or session and releases the microphone');
    results.push('P2P-only community voice: refused before any peer offer, leaves no session, relay or microphone');

    setCallTransportMode('wabidb'); failCapture = true;
    assert(await joinVoiceChannel(current as any, 'failed-source').then(() => false, () => true), 'initial microphone denial rejects join');
    const afterFailure = current.sent.length;
    await handleForcedVoiceMove(current as any, 'failed-source', 'unrequested-destination');
    assert(current.sent.length === afterFailure && !get(isInCall) && !get(localStream) && callSessionManager.list().length === 0,
      'stale move after failed join cannot start an unrequested call');
    results.push('failed initial join retires socket ownership; stale moderator events cannot acquire a new microphone or call');

    // Auto keeps a P2P tail for DMs/groups only; on community voice a dead
    // relay must fail the join, never fall through to a mesh offer.
    setCallTransportMode('auto');
    await joinVoiceChannel(current as any, 'failure-canary');
    assert(relays().includes('failure-canary'), 'canary owns a real relay');
    let fallbackOffers = 0;
    RTCPeerConnection.prototype.createOffer = function(...args: any[]): any { fallbackOffers++; return originalOffer.apply(this, args as any); };
    voiceChannelMembers.update(roster => ({ ...roster, 'failed-transport': [{ userId: 'unanswered-peer', username: 'Unavailable',
      isSpeaking: false, isMuted: false, isDeafened: false }] }));
    current.relayDenied.add('failed-transport');
    const transportFailed = await joinVoiceChannel(current as any, 'failed-transport').then(() => false, () => true);
    RTCPeerConnection.prototype.createOffer = originalOffer;
    assert(transportFailed && !relays().includes('failed-transport') && !callSessionManager.get('failed-transport'), 'failed relay join surfaces failure and retires its relay and visible session');
    assert(fallbackOffers === 0, 'Auto never falls through to a P2P offer for community voice');
    assert(relays().includes('failure-canary') && callSessionManager.get('failure-canary') && get(localStream)?.getAudioTracks()[0].readyState === 'live', 'failed join preserves unrelated relay and microphone consumer');
    await leaveVoiceChannel(current as any, 'failure-canary');
    setCallTransportMode('wabidb');
    results.push('denied relay join: failure surfaces, no P2P fallback, its relay/session retired, unrelated relay/capture preserved');
    return results;
  } finally {
    holdLeave = false; heldLeaves.splice(0).forEach(resolve => resolve()); clearInterval(painter);
    revokeGroupCall('group-canary');
    for (const session of callSessionManager.list()) await leaveVoiceChannel(current as any, session.id);
    cleanupAllConnections(); callSessionManager.leaveAll(); await disconnectWabidbCall();
    sources.forEach(stream => stream.getTracks().forEach(track => track.stop())); await context.close();
    window.fetch = originalFetch; window.WebSocket = OriginalWebSocket;
    navigator.mediaDevices.getUserMedia = originalCapture; navigator.mediaDevices.getDisplayMedia = originalDisplay; setAuthToken(null);
    RTCPeerConnection.prototype.createOffer = originalOffer; setCallTransportMode('wabidb');
    voiceChannelMembers.set({});
  }
}
(window as any).__audioSmoke = { status: 'ready' };
document.querySelector('#run')!.addEventListener('click', () => {
  (window as any).__audioSmoke = { status: 'running' };
  void run().then(results => { (window as any).__audioSmoke = { status: 'passed', results }; },
    error => { (window as any).__audioSmoke = { status: 'failed', error: String(error), stack: error?.stack, results: (window as any).__audioSmoke.results }; });
});
