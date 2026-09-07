// Production call owners + encoders; fixture HTTP/Socket.IO/raw WebSocket.
// No physical microphone, speakers, deployed accounts or remote service.
import { get } from 'svelte/store';
import { startGroupCall, joinVoiceChannel, leaveVoiceChannel, revokeGroupCall, cleanupAllConnections, refreshLocalAudioMuteState } from '../src/lib/calling_impl_core';
import { callSocketDisconnected, callSocketInitialized } from '../src/lib/callSocketLifecycle';
import { getWabidbRelayDiagnostics, disconnectWabidbCall } from '../src/lib/callingWabidb';
import { localStream, activeGroupCall, isMuted, callOfflineNotice } from '../src/lib/callingStateStores';
import { groupMembership } from '../src/lib/groupAccess';
import { setConfiguredServerUrl } from '../src/lib/serverUrl';
import { setAuthToken, setStoredDbUserId } from '../src/lib/authSession';
import { setAudioProcessingMode, setCallTransportMode } from '../src/lib/mediaRuntime';
import { callSessionManager } from '../src/lib/callSessionManager';
import { subscribeVoiceChannel, unsubscribeVoiceChannel } from '../src/lib/presenceStore';
import { socketManager } from '../src/lib/socketConnection';

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
  connected = true; holdAdmission = false;
  sent: [string, any][] = [];
  listeners = new Map<string, Set<(data: any) => void>>();
  constructor(public id: string) {}
  on(event: string, fn: (data: any) => void) { const set = this.listeners.get(event) ?? new Set(); set.add(fn); this.listeners.set(event, set); return this; }
  off(event: string, fn: (data: any) => void) { this.listeners.get(event)?.delete(fn); return this; }
  emit(event: string, data: any) {
    this.sent.push([event, data]);
    if (event === 'join-wabidb-call') queueMicrotask(() => this.receive('wabidb-call-joined', data));
    if (event === 'call-initiate' && !this.holdAdmission) queueMicrotask(() => this.receive('group-call-started', { ...data, established: true }));
    if (event === 'voice-channel-join' || event === 'voice-channel-subscribe') queueMicrotask(() => this.receive('voice-channel-admitted', data));
    return this;
  }
  receive(event: string, data: any) { for (const fn of [...this.listeners.get(event) ?? []]) fn(data); }
  retire() {
    // Explicit SocketManager replacement removes listeners BEFORE disconnect;
    // owners must retire synchronously through this hook, not rely on events.
    callSocketDisconnected(this as any);
    this.listeners.clear(); this.connected = false;
    groupMembership.beginConnection();
  }
}

async function run() {
  const results: string[] = [];
  const originalFetch = window.fetch, OriginalWebSocket = window.WebSocket;
  const context = new AudioContext(); await context.resume();
  const oscillator = context.createOscillator(), destination = context.createMediaStreamDestination();
  oscillator.connect(destination); oscillator.start();
  const requests: string[] = [];
  const relays = () => getWabidbRelayDiagnostics().map(row => row.key);
  let captures = 0;
  setConfiguredServerUrl(location.origin, false);
  setAuthToken(`header.${btoa(JSON.stringify({ sub: '1', exp: 4102444800 }))}.fixture`);
  setStoredDbUserId(1); setAudioProcessingMode('studio'); setCallTransportMode('wabidb');
  window.WebSocket = RawSocket as any;
  window.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input); requests.push(url);
    const channel = url.match(/\/api\/channels\/([^/]+)\/join/);
    return new Response(JSON.stringify(channel ? { joined: true, channelId: channel[1] } : {}), { status: 200 });
  }) as typeof fetch;
  navigator.mediaDevices.getUserMedia = async () => { captures++; return destination.stream; };
  const init = (revision = '1') => {
    const realm = groupMembership.realm()!;
    assert(groupMembership.apply({ id: 'group-reconnect', name: 'Reconnect', type: 'group', createdAt: 0,
      ownerId: 'user-1', members: ['user-1', 'user-2'], membershipRevision: revision }, realm), 'init membership accepted');
    groupMembership.finishInit(realm);
  };
  let current = new FixtureSocket('original');
  (socketManager as any).socketInstance = current;
  try {
    init();
    await joinVoiceChannel(current as any, 'voice-primary');
    await subscribeVoiceChannel('voice-background'); // actual sidebar API
    await startGroupCall(current as any, 'group-reconnect', 'Reconnect');
    assert(relays().length === 3, 'three actual relays established');
    const stream = get(localStream), captureCount = captures;
    isMuted.set(true);
    callSessionManager.setFocus('voice-background');
    callSessionManager.setVolume('voice-background', 37);
    const leftBefore = requests.filter(url => url.includes('/leave')).length;
    const original = current;
    original.retire();
    assert(relays().length === 0, 'all old group/voice relays retired before listener removal');
    assert(callSessionManager.list().every(session => session.lifecycle === 'reconnecting'), 'each retained session honestly reconnecting');
    assert(requests.filter(url => url.includes('/leave')).length === leftBefore, 'transient retirement sends no durable account leave');
    assert(get(localStream) === stream && stream!.getAudioTracks()[0].readyState === 'live', 'capture retained without reopening permission');

    current = new FixtureSocket('replacement'); current.holdAdmission = true;
    await callSocketInitialized(current as any); // not authoritative yet
    assert(current.sent.length === 0, 'group/voice recovery waits for authoritative init');
    init();
    const recovering = callSocketInitialized(current as any);
    const clickedDuringRecovery = joinVoiceChannel(current as any, 'voice-primary');
    assert(joinVoiceChannel(current as any, 'voice-primary') === clickedDuringRecovery, 'manual join coalesces with in-flight reconnect owner');
    await until(() => current.sent.some(([event]) => event === 'call-initiate'), 'group readmission request');
    const admission = current.sent.find(([event]) => event === 'call-initiate')![1];
    assert(admission.rejoin === true && admission.membershipRevision === '1', 'non-ringing readmission pins original revision');
    await until(() => relays().includes('voice-background') && relays().includes('voice-primary'), 'background and primary voice readmitted independently');
    assert(!relays().includes('group-reconnect') && !current.sent.some(([event, data]) => event === 'join-wabidb-call' && data.channelId === 'group-reconnect'), 'group media cannot precede admission');
    current.receive('group-call-started', { ...admission, established: true });
    await recovering;
    await clickedDuringRecovery;
    assert(current.sent.filter(([event]) => event === 'voice-channel-join').length === 1, 'manual click cannot supersede automatic voice admission');
    assert(relays().length === 3 && captures === captureCount && get(isMuted), 'new-socket relays restored without new capture or unmuting');
    assert(callSessionManager.get('voice-background')?.focus === 'focused' && callSessionManager.get('voice-background')?.volume === 37, 'recovery preserves user focus and per-session volume');
    const oldMediaCount = original.sent.filter(([event]) => event === 'wabidb-media').length;
    isMuted.set(false); refreshLocalAudioMuteState();
    await until(() => current.sent.some(([event, data]) => event === 'wabidb-media' && data.sessionId === 'channel:group-reconnect'), 'real encoded group audio on replacement socket');
    assert(original.sent.filter(([event]) => event === 'wabidb-media').length === oldMediaCount, 'old socket never resumes media emission');
    const beforeDuplicate = current.sent.filter(([event]) => event === 'call-initiate').length;
    await callSocketInitialized(current as any);
    assert(current.sent.filter(([event]) => event === 'call-initiate').length === beforeDuplicate, 'duplicate init does not restart live owners');
    results.push('socket replacement: group + primary/background voice reauthorize before rebuilding; capture, mute, focus and volume retained');

    // Replace a recovering socket while its group admission is pending.
    current.retire(); init();
    const stale = new FixtureSocket('stale'); stale.holdAdmission = true;
    const oldRecovery = callSocketInitialized(stale as any);
    await until(() => stale.sent.some(([event]) => event === 'call-initiate'), 'old pending readmission');
    stale.retire(); init();
    current = new FixtureSocket('fresh');
    await callSocketInitialized(current as any);
    stale.receive('group-call-started', { ...stale.sent.find(([event]) => event === 'call-initiate')![1], established: true });
    await oldRecovery;
    assert(relays().includes('group-reconnect') && get(activeGroupCall)?.id === 'group-reconnect', 'retired admission completion cannot erase fresh call');
    assert(!stale.sent.some(([event, data]) => event === 'join-wabidb-call' && data.sessionId === 'channel:group-reconnect'), 'unadmitted old group socket never gets a media room after retirement');
    results.push('repeated disconnect: late old admission cannot activate media or erase the replacement');

    // A final init may contain a re-added account with no intermediate tombstone.
    current.retire(); init('3');
    current = new FixtureSocket('after-offline-membership-change');
    await callSocketInitialized(current as any);
    assert(!get(activeGroupCall) && !relays().includes('group-reconnect'), 'offline remove/re-add cannot resume the prior group call');
    assert(!current.sent.some(([event]) => event === 'call-initiate'), 'changed revision requires new explicit user intent');
    assert(get(callOfflineNotice)?.includes('membership changed'), 'readmission failure is visible');
    assert(relays().includes('voice-primary') && relays().includes('voice-background') && get(localStream) === stream, 'group readmission denial preserves other call recovery');
    results.push('offline membership revision change: old group intent rejected; unrelated voice recovery and shared capture survive');
    await startGroupCall(current as any, 'group-reconnect', 'New explicit call');
    await leaveVoiceChannel(current as any, 'voice-primary');
    assert(relays().includes('group-reconnect') && relays().includes('voice-background'), 'primary voice leave preserves group and background relays');
    assert(callSessionManager.get('group-reconnect') && callSessionManager.get('voice-background') && !callSessionManager.get('voice-primary'), 'primary leave removes exactly one session from the model');
    assert(get(localStream) === stream && stream!.getAudioTracks()[0].readyState === 'live', 'primary leave retains shared microphone consumers');
    results.push('primary voice leave: group and background relay/session/capture remain intact');
    current.retire();
    (socketManager as any).socketInstance = null;
    await unsubscribeVoiceChannel('voice-background');
    init('3'); current = new FixtureSocket('after-offline-leave');
    (socketManager as any).socketInstance = current;
    await callSocketInitialized(current as any);
    assert(!relays().includes('voice-background') && !callSessionManager.get('voice-background'), 'offline sidebar unsubscribe cancels retained intent without a queued leave');
    assert(relays().includes('group-reconnect'), 'offline background leave does not cancel group recovery');
    results.push('sidebar APIs own real listener media; offline unsubscribe cancels intent across socket replacement');
    return results;
  } finally {
    revokeGroupCall('group-reconnect');
    await leaveVoiceChannel(current as any, 'voice-background');
    await leaveVoiceChannel(current as any, 'voice-primary');
    cleanupAllConnections(); callSessionManager.leaveAll(); await disconnectWabidbCall();
    destination.stream.getTracks().forEach(track => track.stop()); await context.close();
    window.fetch = originalFetch; window.WebSocket = OriginalWebSocket; setAuthToken(null);
    (socketManager as any).socketInstance = null;
  }
}
(window as any).__audioSmoke = { status: 'ready' };
document.querySelector('#run')!.addEventListener('click', () => {
  (window as any).__audioSmoke = { status: 'running' };
  void run().then(results => { (window as any).__audioSmoke = { status: 'passed', results }; },
    error => { (window as any).__audioSmoke = { status: 'failed', error: String(error), stack: error?.stack }; });
});
