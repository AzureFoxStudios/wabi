// Real call entry points, capture ownership, peer connections and session graph.
// Only admission/HTTP and generated capture streams are fixtures. No devices.
import { get } from 'svelte/store';
import { mount, unmount } from 'svelte';
import { setWabidbRemoteVideoStream } from '../src/lib/wabidbVideoLane';
import { selectedRemoteVideo } from '../src/lib/callingVideoState';
import { startGroupCall, answerCall, revokeGroupCall, createCallOffer, handleGroupCallParticipantJoined,
  cleanupAllConnections, shouldSendAudioToChannel, toggleVideo, startScreenShare,
  stopScreenShare, createScreenShareOffer, screenShareTargetsCurrent } from '../src/lib/calling_impl_core';
import { localStream, activeGroupCall, activeCallSessionId, outgoingCall, incomingCall,
  listeningVoiceChannels, voiceTransmitMode, isInCall, localScreenStream, isSharing, isVideoOff } from '../src/lib/callingStateStores';
import { groupMembership } from '../src/lib/groupAccess';
import { callSessionManager } from '../src/lib/callSessionManager';
import { setAuthToken, setStoredDbUserId } from '../src/lib/authSession';
import { setConfiguredServerUrl } from '../src/lib/serverUrl';
import { setAudioProcessingMode, setCallTransportMode } from '../src/lib/mediaRuntime';

function assert(value: unknown, label: string) { if (!value) throw new Error(label); }
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 250; i++) { if (check()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error(`Timed out: ${label}`);
}
class FixtureSocket {
  id = 'group-audio-socket'; connected = true; admit = true; established = false;
  admitScreen = true;
  sent: [string, any][] = [];
  listeners = new Map<string, Set<(data: any) => void>>();
  on(event: string, fn: (data: any) => void) { const set = this.listeners.get(event) ?? new Set(); set.add(fn); this.listeners.set(event, set); return this; }
  off(event: string, fn: (data: any) => void) { this.listeners.get(event)?.delete(fn); return this; }
  emit(event: string, data: any) {
    this.sent.push([event, data]);
    if (event === 'start-screen-share') queueMicrotask(() => this.receive(this.admitScreen ? 'screen-share-targets' : 'screen-share-error', { ...data, targets: [], error: 'Share denied' }));
    if (event === 'call-initiate' || event === 'call-answer') queueMicrotask(() => this.receive(this.admit
      ? event === 'call-initiate' ? 'group-call-started' : 'group-call-admitted' : 'call-error',
      { ...data, message: 'Group is unavailable', established: this.established }));
    return this;
  }
  receive(event: string, data: any) { for (const fn of [...this.listeners.get(event) ?? []]) fn(data); }
}

async function run() {
  const results: string[] = [];
  (window as any).__audioSmoke.results = results;
  const socket = new FixtureSocket();
  const context = new AudioContext(); await context.resume();
  const tracks: MediaStreamTrack[] = [];
  const tone = () => {
    const source = context.createOscillator(); const destination = context.createMediaStreamDestination();
    source.connect(destination); source.start(); // never connected to speakers
    tracks.push(...destination.stream.getTracks()); return destination.stream;
  };
  const originalFetch = window.fetch;
  const originalDescription = RTCPeerConnection.prototype.setLocalDescription;
  let revision = 1;
  const grant = () => {
    const realm = groupMembership.realm()!;
    assert(groupMembership.apply({ id: 'group-audio', name: 'Audio', type: 'group', createdAt: 0,
      ownerId: 'user-1', members: ['user-1', 'user-2'], membershipRevision: String(revision++) }, realm), 'fresh membership accepted');
    groupMembership.finishInit(realm);
  };
  const remove = () => groupMembership.revoke('group-audio', String(revision++), groupMembership.realm()!);
  setConfiguredServerUrl(location.origin, false);
  setAuthToken(`header.${btoa(JSON.stringify({ sub: '1', exp: 4102444800 }))}.fixture`);
  setStoredDbUserId(1); setAudioProcessingMode('studio'); setCallTransportMode('p2p-only');
  window.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).includes('/join')) return new Response('{"joined":true,"channelId":"group-audio"}', { status: 200 });
    return new Response('{}', { status: 400 });
  }) as typeof fetch;
  try {
    grant();
    let captures = 0;
    navigator.mediaDevices.getUserMedia = async () => { captures++; throw new Error('Capture must not start'); };
    socket.admit = false;
    const denied = await startGroupCall(socket as any, 'group-audio', 'Audio').catch(error => error);
    assert(denied.message === 'Group is unavailable' && captures === 0, 'start denial occurs before capture');
    assert(!get(outgoingCall) && !get(localStream), 'denied start leaves no ringing/mic');
    incomingCall.set({ userId: 'user-2', username: 'Peer', isVideoCall: false, channelId: 'group-audio' });
    const answerDenied = await answerCall(socket as any, 'user-2', false, { channelId: 'group-audio' }).catch(error => error);
    assert(answerDenied instanceof Error && captures === 0, 'answer denial occurs before capture');
    incomingCall.set(null);
    results.push('start and answer: server denial before microphone permission');

    socket.admit = true;
    let finishOldCapture!: (stream: MediaStream) => void;
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { finishOldCapture = resolve; });
    const oldAttempt = startGroupCall(socket as any, 'group-audio', 'Audio');
    assert(startGroupCall(socket as any, 'group-audio', 'Audio') === oldAttempt, 'double click shares the pending call owner');
    const oldResult = oldAttempt.catch(error => error);
    await until(() => Boolean(finishOldCapture), 'pending permission');
    remove(); grant();
    navigator.mediaDevices.getUserMedia = async () => tone();
    const fresh = await startGroupCall(socket as any, 'group-audio', 'Audio');
    const late = tone(); finishOldCapture(late);
    assert((await oldResult).name === 'AbortError', 'removed pending call rejects');
    await until(() => late.getTracks().every(track => track.readyState === 'ended'), 'late capture disposal');
    assert(get(localStream) === fresh && fresh.getAudioTracks()[0].readyState === 'live', 'old cleanup cannot stop re-added call');
    remove(); assert(!get(localStream), 'last group owner releases capture');
    results.push('remove/re-add during permission: late stream disposed, new call survives');

    grant();
    const shared = tone(); localStream.set(shared);
    listeningVoiceChannels.set(['voice-canary']);
    callSessionManager.register({ id: 'voice-canary', channelId: 'voice-canary', name: 'Background', kind: 'channel', direction: 'listen' });
    callSessionManager.markConnected('voice-canary', 'p2p');
    const voicePeer = await createCallOffer(socket as any, 'voice-peer', 'Voice peer', { channelId: 'voice-canary', forceTransport: 'p2p' });
    let finishCamera!: (stream: MediaStream) => void;
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { finishCamera = resolve; });
    const cameraAttempt = startGroupCall(socket as any, 'group-audio', 'Audio', true).catch(error => error);
    await until(() => Boolean(finishCamera), 'pending camera');
    remove();
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
    const camera = canvas.captureStream(); tracks.push(...camera.getTracks()); finishCamera(camera);
    assert((await cameraAttempt).name === 'AbortError', 'removed camera attempt rejects');
    assert(camera.getTracks().every(track => track.readyState === 'ended'), 'late camera stopped before attaching');
    assert(shared.getAudioTracks()[0].readyState === 'live' && get(localStream) === shared, 'background mic retained');
    assert(callSessionManager.get('voice-canary')?.lifecycle === 'connected' && voicePeer?.connectionState !== 'closed', 'background session and peer retained');
    results.push('remove during camera permission: late video stopped, unrelated listener/peer/mic retained');

    grant();
    navigator.mediaDevices.getUserMedia = async () => tone();
    socket.established = true;
    isInCall.set(true); // a surviving voice call must not masquerade as THIS group
    await startGroupCall(socket as any, 'group-audio', 'Audio');
    assert(callSessionManager.get('group-audio')?.kind === 'group' && !get(outgoingCall), 'joining an established call registers its own group session');
    let finishOffer!: () => void;
    RTCPeerConnection.prototype.setLocalDescription = async function(...args) {
      await originalDescription.apply(this, args);
      await new Promise<void>(resolve => { finishOffer = resolve; });
    };
    const negotiation = createCallOffer(socket as any, 'group-peer', 'Group peer', { channelId: 'group-audio', forceTransport: 'p2p' }).catch(error => error);
    await until(() => Boolean(finishOffer), 'pending local SDP');
    remove(); grant(); finishOffer();
    assert((await negotiation).name === 'AbortError', 'retired peer negotiation rejects after re-add');
    assert(!socket.sent.some(([event, data]) => event === 'call-offer' && data.targetId === 'group-peer'), 'no stale group offer emitted');
    RTCPeerConnection.prototype.setLocalDescription = originalDescription;
    await handleGroupCallParticipantJoined(socket as any, { channelId: 'group-audio', userId: 'unsolicited', username: 'Unsolicited' });
    assert(!get(activeGroupCall) && !get(activeCallSessionId), 'unsolicited participant event cannot establish a call');
    voiceTransmitMode.set('all-listening'); remove();
    assert(!shouldSendAudioToChannel('group-audio') && shouldSendAudioToChannel('voice-canary'), 'broadcast mode cannot bypass removed-group fence');
    assert(voicePeer?.connectionState !== 'closed' && get(localStream) === shared, 'late peer completion preserves background call');
    results.push('established group admission with voice backdrop registers its own session; remove during SDP cannot emit or resurrect');
    results.push('all-listening respects revocation and preserves the background peer/capture');

    const videoStream = () => {
      const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
      canvas.getContext('2d')!.fillRect(0, 0, 32, 32);
      const stream = canvas.captureStream(); tracks.push(...stream.getTracks()); return stream;
    };
    grant(); await startGroupCall(socket as any, 'group-audio', 'Audio');
    let finishToggle!: (stream: MediaStream) => void;
    isVideoOff.set(true);
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { finishToggle = resolve; });
    const toggle = toggleVideo(socket as any);
    assert(toggleVideo(socket as any) === toggle, 'camera double click has one permission owner');
    await until(() => !!finishToggle, 'pending camera toggle');
    remove(); grant(); finishToggle(videoStream()); await toggle;
    assert(get(localStream) === shared && shared.getVideoTracks().length === 0 && get(isVideoOff), 'retired camera toggle cannot modify the retained microphone stream');
    assert(tracks.at(-1)?.readyState === 'ended', 'retired toggle camera disposed');
    results.push('camera toggle permission: coalesced, cancelled by removal, background microphone untouched');

    navigator.mediaDevices.getUserMedia = async () => tone();
    await startGroupCall(socket as any, 'group-audio', 'Audio');
    let finishPicker!: (stream: MediaStream) => void;
    navigator.mediaDevices.getDisplayMedia = () => new Promise(resolve => { finishPicker = resolve; });
    const pendingShare = startScreenShare(socket as any);
    assert(startScreenShare(socket as any) === pendingShare, 'screen double click owns one picker');
    await until(() => !!finishPicker, 'pending screen picker');
    remove(); grant();
    await startGroupCall(socket as any, 'group-audio', 'Audio');
    const freshScreen = videoStream();
    navigator.mediaDevices.getDisplayMedia = async () => freshScreen;
    assert(await startScreenShare(socket as any) === freshScreen, 're-added call can share');
    const staleScreen = videoStream(); finishPicker(staleScreen);
    assert(await pendingShare === null && staleScreen.getTracks()[0].readyState === 'ended', 'late picker disposed');
    assert(get(localScreenStream) === freshScreen && get(isSharing), 'old picker cannot stop new share');
    const shareRequest = socket.sent.findLast(([event]) => event === 'start-screen-share')![1];
    assert(shareRequest.channelId === 'group-audio' && typeof shareRequest.membershipRevision === 'string', 'share start carries explicit destination and revision');
    assert(screenShareTargetsCurrent(shareRequest.requestId) && !screenShareTargetsCurrent('retired'), 'target replies require the current picker generation');

    let finishScreenOffer!: () => void;
    RTCPeerConnection.prototype.setLocalDescription = async function(...args) {
      await originalDescription.apply(this, args);
      await new Promise<void>(resolve => { finishScreenOffer = resolve; });
    };
    const screenOffer = createScreenShareOffer(socket as any, 'screen-peer', shareRequest.requestId);
    await until(() => !!finishScreenOffer, 'screen SDP awaiting');
    stopScreenShare(socket as any);
    const replacementScreen = videoStream(); navigator.mediaDevices.getDisplayMedia = async () => replacementScreen;
    await startScreenShare(socket as any); finishScreenOffer(); await screenOffer;
    assert(!socket.sent.some(([event, data]) => event === 'webrtc-offer' && data.requestId === shareRequest.requestId), 'stopped screen SDP cannot emit after replacement');
    assert(get(localScreenStream) === replacementScreen && replacementScreen.getTracks()[0].readyState === 'live', 'late SDP cleanup preserves replacement share');
    remove(); assert(!get(isSharing) && !get(localScreenStream) && replacementScreen.getTracks()[0].readyState === 'ended', 'removal stops only owned screen capture');
    assert(shared.getAudioTracks()[0].readyState === 'live' && voicePeer?.connectionState !== 'closed', 'screen revocation preserves background audio and peer');
    results.push('screen picker and SDP races: explicit call scope, stale completions cannot restart/stop replacements');

    grant(); await startGroupCall(socket as any, 'group-audio', 'Audio');
    socket.admitScreen = false;
    const deniedShare = videoStream(); navigator.mediaDevices.getDisplayMedia = async () => deniedShare;
    assert(await startScreenShare(socket as any) === null, 'server denial cannot report screen sharing success');
    assert(deniedShare.getTracks()[0].readyState === 'ended' && !get(isSharing), 'denial stops capture and preview');
    socket.admitScreen = true; remove();
    results.push('screen admission denial: no success state and captured tracks released');

    RTCPeerConnection.prototype.setLocalDescription = originalDescription;
    grant(); await startGroupCall(socket as any, 'group-audio', 'Audio');
    navigator.mediaDevices.getUserMedia = async () => videoStream();
    await toggleVideo(socket as any);
    const backgroundNegotiation = await createCallOffer(socket as any, 'new-background-peer', 'Other call', { channelId: 'voice-canary', forceTransport: 'p2p' });
    assert(!backgroundNegotiation?.getSenders().some(sender => sender.track?.kind === 'video'), 'new background peer must not receive the group camera');
    results.push('P2P camera: background peer creation cannot publish a foreground group camera');

    const groupFeed = videoStream(), voiceFeed = videoStream();
    const groupOwner = {}, voiceOwner = {};
    setWabidbRemoteVideoStream('user-2:screen', groupFeed, groupOwner, 'group-audio');
    setWabidbRemoteVideoStream('user-2:screen', voiceFeed, voiceOwner, 'voice-canary');
    callSessionManager.upsertParticipant('group-audio', { userId: 'user-2', username: 'Peer' });
    callSessionManager.upsertParticipant('voice-canary', { userId: 'user-2', username: 'Peer' });
    const groupHost = document.createElement('div'), voiceHost = document.createElement('div');
    document.body.append(groupHost, voiceHost);
    const { default: CallStage } = await import('../src/lib/components/CallStage.svelte');
    const groupStage = mount(CallStage, { target: groupHost, props: { session: callSessionManager.get('group-audio')! } });
    const voiceStage = mount(CallStage, { target: voiceHost, props: { session: callSessionManager.get('voice-canary')! } });
    try {
      await until(() => !!groupHost.querySelector('video')?.srcObject && !!voiceHost.querySelector('video')?.srcObject, 'both live call stages rendered');
      assert(groupHost.querySelector('video')?.srcObject === groupFeed && voiceHost.querySelector('video')?.srcObject === voiceFeed, 'same participant displays the correct per-call stream');
      assert(get(selectedRemoteVideo).get('user-2:screen') === groupFeed, 'legacy modal selector uses current group not last arrival');
      setWabidbRemoteVideoStream('user-2:screen', null, groupOwner, 'group-audio');
      await until(() => groupHost.querySelectorAll('video').length === 0, 'revoked group tile removed');
      assert(voiceHost.querySelector('video')?.srcObject === voiceFeed, 'removing group feed preserves background tile');
      results.push('real Svelte call stages: same-user feeds stay session-scoped, group tile removal preserves background video');
    } finally {
      setWabidbRemoteVideoStream('user-2:screen', null, groupOwner, 'group-audio');
      setWabidbRemoteVideoStream('user-2:screen', null, voiceOwner, 'voice-canary');
      await unmount(groupStage); await unmount(voiceStage); groupHost.remove(); voiceHost.remove();
    }
    return results;
  } finally {
    RTCPeerConnection.prototype.setLocalDescription = originalDescription;
    revokeGroupCall('group-audio'); cleanupAllConnections(); callSessionManager.leaveAll();
    tracks.forEach(track => track.stop()); await context.close();
    window.fetch = originalFetch; setAuthToken(null);
  }
}
(window as any).__audioSmoke = { status: 'ready' };
document.querySelector('#run')!.addEventListener('click', () => {
  (window as any).__audioSmoke = { status: 'running' };
  void run().then(results => { (window as any).__audioSmoke = { status: 'passed', results }; },
    error => { (window as any).__audioSmoke = { status: 'failed', error: String(error), stack: error?.stack }; });
});
