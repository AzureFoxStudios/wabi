// Production panel, sidebar roster, call owners and media stores. Server and
// capture inputs are fixtures; no live accounts, microphone or speaker output.
import { voiceViewOpen } from '../src/lib/voiceView';
import { selectWorkspaceView } from '../src/lib/workspaceNavigationState';
import { mount, unmount, tick } from 'svelte';
import { get } from 'svelte/store';
import CallModal from '../src/lib/components/CallModal.svelte';
import VoiceChannelList from '../src/lib/components/sidebar/VoiceChannelList.svelte';
import { startGroupCall, joinVoiceChannel, leaveVoiceChannel, revokeGroupCall,
  toggleChannelCallPanelFor, cleanupAllConnections } from '../src/lib/calling_impl_core';
import { callSocketDisconnected } from '../src/lib/callSocketLifecycle';
import { disconnectWabidbCall } from '../src/lib/callingWabidb';
import { activeGroupCall, localStream, channelCallPanelOpen } from '../src/lib/callingStateStores';
import { setWabidbRemoteVideoStream } from '../src/lib/wabidbVideoLane';
import { channels, currentChannel } from '../src/lib/channelStore';
import { voiceChannelMembers, currentUser } from '../src/lib/presenceStore';
import { callSessionManager, focusedCallSessionId } from '../src/lib/callSessionManager';
import { groupMembership } from '../src/lib/groupAccess';
import { setConfiguredServerUrl } from '../src/lib/serverUrl';
import { setAuthToken, setStoredDbUserId } from '../src/lib/authSession';
import { setAudioProcessingMode, setCallTransportMode } from '../src/lib/mediaRuntime';
import { socketManager } from '../src/lib/socketConnection';
import '../src/styles/styles.css';

function assert(value: unknown, message: string) { if (!value) throw new Error(message); }
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
  connected = true; id = 'panel-socket';
  listeners = new Map<string, Set<(data: any) => void>>();
  on(event: string, fn: (data: any) => void) { const set = this.listeners.get(event) ?? new Set(); set.add(fn); this.listeners.set(event, set); return this; }
  off(event: string, fn: (data: any) => void) { this.listeners.get(event)?.delete(fn); return this; }
  emit(event: string, data: any) {
    if (event === 'join-wabidb-call') queueMicrotask(() => this.receive('wabidb-call-joined', data));
    if (event === 'call-initiate') queueMicrotask(() => this.receive('group-call-started', { ...data, established: true }));
    if (event === 'voice-channel-join' || event === 'voice-channel-subscribe') queueMicrotask(() => this.receive('voice-channel-admitted', data));
    return this;
  }
  receive(event: string, data: any) { for (const fn of [...this.listeners.get(event) ?? []]) fn(data); }
}

async function run() {
  const results: string[] = [], failures: string[] = [];
  (window as any).__audioSmoke.results = results;
  const check = (condition: unknown, label: string) => { if (!condition) failures.push(label); };
  const originalFetch = window.fetch, OriginalWebSocket = window.WebSocket, originalCapture = navigator.mediaDevices.getUserMedia;
  const context = new AudioContext(); await context.resume();
  const oscillator = context.createOscillator(), destination = context.createMediaStreamDestination();
  oscillator.connect(destination); oscillator.start();
  const video = () => { const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32; canvas.getContext('2d')!.fillRect(0, 0, 32, 32); return canvas.captureStream(); };
  const cameraA = video(), screenB = video(), ownerA = {}, ownerB = {};
  let modal: ReturnType<typeof mount> | undefined, roster: ReturnType<typeof mount> | undefined;
  const panelRoot = document.createElement('div'), rosterRoot = document.createElement('div');
  document.body.append(panelRoot, rosterRoot);
  const socket = new FixtureSocket();
  setConfiguredServerUrl(location.origin, false);
  setAuthToken(`header.${btoa(JSON.stringify({ sub: '1', exp: 4102444800 }))}.fixture`);
  setStoredDbUserId(1); setAudioProcessingMode('studio'); setCallTransportMode('wabidb');
  currentUser.set({ id: 'user-1', dbUserId: 1, username: 'Self' } as any);
  (socketManager as any).socketInstance = socket;
  window.WebSocket = RawSocket as any;
  window.fetch = (async (input: RequestInfo | URL) => {
    const channel = String(input).match(/\/api\/channels\/([^/]+)\/join/);
    return new Response(JSON.stringify(channel ? { joined: true, channelId: channel[1] } : {}), { status: 200 });
  }) as typeof fetch;
  navigator.mediaDevices.getUserMedia = async () => destination.stream;
  try {
    const voiceChannels = ['voice-a', 'voice-b'].map(id => ({ id, name: id, type: 'voice' as const, createdAt: 0 }));
    channels.set(voiceChannels);
    const realm = groupMembership.realm()!;
    groupMembership.apply({ id: 'group-panel', name: 'Group', type: 'group', createdAt: 0,
      ownerId: 'user-1', members: ['user-1', 'user-2'], membershipRevision: '1' }, realm);
    groupMembership.finishInit(realm);
    currentChannel.set('voice-a'); selectWorkspaceView('voice'); currentChannel.set('voice-b');
    assert(!get(voiceViewOpen), 'channel navigation closes the Voice dashboard');
    await joinVoiceChannel(socket as any, 'voice-a');
    await joinVoiceChannel(socket as any, 'voice-b', { listenOnly: true });
    await startGroupCall(socket as any, 'group-panel', 'Group');
    const sharedCapture = get(localStream);
    for (const view of ['planner', 'files', 'whiteboard', 'voice', 'messages'] as const) {
      selectWorkspaceView(view);
      assert(get(localStream) === sharedCapture && callSessionManager.list().length === 3 &&
        get(focusedCallSessionId) === 'group-panel', 'workspace navigation preserves all calls, capture and transmit focus');
    }
    const member = { userId: 'user-2', username: 'Same peer', isSpeaking: false, isMuted: false, isDeafened: false };
    voiceChannelMembers.set({ 'voice-a': [member], 'voice-b': [member] });
    setWabidbRemoteVideoStream('user-2:camera', cameraA, ownerA, 'voice-a');
    setWabidbRemoteVideoStream('user-2:screen', screenB, ownerB, 'voice-b');
    modal = mount(CallModal, { target: panelRoot });
    roster = mount(VoiceChannelList, { target: rosterRoot, props: { voiceChannels, allVoiceChannels: voiceChannels,
      breakoutChannelsByParent: {}, connectedVoiceChannelIds: new Set(['voice-a', 'voice-b']), runtimeActiveVoiceChannelId: 'voice-a',
      voiceDropTargetChannelId: null, voicePresenceSince: new Map(), voiceDurationMode: 'off', nowMs: Date.now(), followedChannelIds: new Set<string>(),
      onVoiceChannelClick: id => toggleChannelCallPanelFor(id), onChannelRightClick() {}, onChannelLongPress() {},
      onToggleChannelFollow() {}, onToggleListenChannel() {}, onOpenVoiceChannelWhiteboard() {},
      onVoiceMemberDragStart() {}, onVoiceMemberDragEnd() {}, onVoiceChannelDragOver() {},
      onVoiceChannelDragLeave() {}, onVoiceChannelDrop() {} } });
    await tick();
    const rows = () => [...rosterRoot.querySelectorAll('.voice-channel-item')];
    await until(() => rows().length === 2, 'both real sidebar rows');
    const rowA = rows()[0], rowB = rows()[1];
    const badgeCounts = (row: Element) => {
      const members = row.nextElementSibling;
      assert(members?.classList.contains('voice-member-list'), 'channel has its sibling member list');
      return [members!.querySelectorAll('[aria-label="camera on"]').length, members!.querySelectorAll('[aria-label="sharing screen"]').length];
    };
    check(JSON.stringify(badgeCounts(rowA)) === '[1,0]', `voice A badges contain only A media (camera/screen: ${badgeCounts(rowA)})`);
    check(JSON.stringify(badgeCounts(rowB)) === '[0,1]', `voice B badges contain only B media (camera/screen: ${badgeCounts(rowB)})`);
    setWabidbRemoteVideoStream('user-2:screen', null, ownerB, 'voice-b'); await tick();
    check(JSON.stringify(badgeCounts(rowB)) === '[0,0]' && JSON.stringify(badgeCounts(rowA)) === '[1,0]', 'removing B media updates its badge without clearing A camera');
    setWabidbRemoteVideoStream('user-2:screen', screenB, ownerB, 'voice-b'); await tick();
    (rowB.querySelector('.channel-btn') as HTMLButtonElement).click();
    await until(() => !!panelRoot.querySelector('.cstage video'), 'targeted embedded CallStage');
    check(get(focusedCallSessionId) === 'group-panel', 'viewing background call does not move microphone focus');
    check([...panelRoot.querySelectorAll('.cstage video')].some(node => (node as HTMLVideoElement).srcObject === screenB) &&
      ![...panelRoot.querySelectorAll('.cstage video')].some(node => (node as HTMLVideoElement).srcObject === cameraA), 'viewed stage uses B feed, not same-user A feed');
    groupMembership.revoke('group-panel', '2', realm); await tick();
    check(!get(activeGroupCall) && !!callSessionManager.get('voice-b') && get(localStream) === sharedCapture &&
      [...panelRoot.querySelectorAll('.cstage video')].some(node => (node as HTMLVideoElement).srcObject === screenB),
      'foreground group revocation preserves viewed background stage and capture');
    groupMembership.apply({ id: 'group-panel', name: 'Group', type: 'group', createdAt: 0,
      ownerId: 'user-1', members: ['user-1', 'user-2'], membershipRevision: '3' }, realm);
    await startGroupCall(socket as any, 'group-panel', 'New explicit group call'); await tick();
    toggleChannelCallPanelFor('voice-b'); await tick();
    check(!get(channelCallPanelOpen) && !panelRoot.querySelector('.call-shell') && callSessionManager.list().length === 3, 'second click actually closes view without leaving calls');
    toggleChannelCallPanelFor('voice-b'); await tick();
    const end = panelRoot.querySelector('.call-controls button.end') as HTMLButtonElement;
    assert(end, 'real panel Hang up control exists'); end.click(); await tick();
    check(!callSessionManager.get('voice-b') && !!get(activeGroupCall) && !!callSessionManager.get('voice-a'), 'viewed background Hang up removes B, not foreground group or A');
    check(get(localStream) === sharedCapture && sharedCapture!.getAudioTracks()[0].readyState === 'live', 'viewed Hang up preserves other capture consumers');
    // The dead explicit target falls back to the displayed focused session.
    toggleChannelCallPanelFor('group-panel'); await tick();
    check(!get(channelCallPanelOpen), 'clicking the displayed fallback folds the panel after targeted call ends');
    results.push('real panel + roster: scoped badges/feeds, group revocation preserves viewed voice stage, view without transmit-focus change, close vs Hang up, dead-target fallback');
    if (failures.length) throw new Error(failures.join('; '));

    toggleChannelCallPanelFor('voice-a'); await tick();
    callSocketDisconnected(socket as any); socket.connected = false;
    (socketManager as any).socketInstance = null;
    (panelRoot.querySelector('.call-controls button.end') as HTMLButtonElement).click(); await tick();
    assert(!callSessionManager.get('voice-a') && callSessionManager.get('group-panel')?.lifecycle === 'reconnecting', 'offline panel Hang up cancels only viewed voice intent');
    (panelRoot.querySelector('.call-controls button.end') as HTMLButtonElement).click(); await tick();
    assert(callSessionManager.list().length === 0 && !get(localStream), 'offline group Hang up cancels the remaining owner and microphone');
    results.push('offline panel Hang up: cancels viewed voice recovery without removing group intent, then group Hang up releases last capture');
    return results;
  } finally {
    if (modal) await unmount(modal); if (roster) await unmount(roster);
    revokeGroupCall('group-panel');
    for (const session of callSessionManager.list()) await leaveVoiceChannel(socket as any, session.id);
    cleanupAllConnections(); callSessionManager.leaveAll(); await disconnectWabidbCall();
    setWabidbRemoteVideoStream('user-2:camera', null, ownerA, 'voice-a');
    setWabidbRemoteVideoStream('user-2:screen', null, ownerB, 'voice-b');
    [...destination.stream.getTracks(), ...cameraA.getTracks(), ...screenB.getTracks()].forEach(track => track.stop()); await context.close();
    window.fetch = originalFetch; window.WebSocket = OriginalWebSocket; navigator.mediaDevices.getUserMedia = originalCapture;
    (socketManager as any).socketInstance = null; currentUser.set(null); voiceChannelMembers.set({}); setAuthToken(null);
    panelRoot.remove(); rosterRoot.remove();
  }
}
(window as any).__audioSmoke = { status: 'ready' };
document.querySelector('#run')!.addEventListener('click', () => {
  (window as any).__audioSmoke = { status: 'running' };
  void run().then(results => { (window as any).__audioSmoke = { status: 'passed', results }; },
    error => { (window as any).__audioSmoke = { status: 'failed', error: String(error), stack: error?.stack, results: (window as any).__audioSmoke.results }; });
});
