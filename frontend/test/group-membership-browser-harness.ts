// Production state, operations, UI, scoped credentials and IndexedDB. Only the
// transport boundary is synthetic; the backend's real Socket.IO tests cover
// authorization/commit/eviction ordering independently.
import { mount } from 'svelte';
import { get } from 'svelte/store';
import GroupMembershipHarness from './GroupMembershipHarness.svelte';
import '../src/styles/styles.css';
import { socketManager } from '../src/lib/socketConnection';
import { socket, connected } from '../src/lib/socketConnectionState';
import { setAuthToken, setStoredDbUserId, setStoredUsername } from '../src/lib/authSession';
import { setConfiguredServerUrl } from '../src/lib/serverUrl';
import { channels, joinChannel, currentChannel, channelLoadingOlder } from '../src/lib/channelStore';
import { channelMessages, unreadCount, channelUnreadCounts } from '../src/lib/messageStore';
import { voiceChannelMembers } from '../src/lib/presenceStore';
import { typingUsers } from '../src/lib/typingStore';
import { selectedDmChannelId, selectedGroupChannel, centerDmChannelId } from '../src/lib/layoutStoreStates';
import { groupMembership } from '../src/lib/groupAccess';
import { openWabiDB, getWabiDB } from '../src/lib/wabidb';
import { QueueDB } from '../src/lib/wabidb/queue/db';
import { drainOutboundQueue } from '../src/lib/wabidb/drain';
import { QueueManager } from '../src/lib/wabidb/queue/manager';
import { registerCallSocketOwner } from '../src/lib/callSocketLifecycle';

class FixtureSocket {
  id = crypto.randomUUID(); connected = true;
  sent: [string, any][] = [];
  listeners = new Map<string, Set<(...args: any[]) => void>>();
  on(event: string, fn: (...args: any[]) => void) { const set = this.listeners.get(event) ?? new Set(); set.add(fn); this.listeners.set(event, set); return this; }
  off(event: string, fn: (...args: any[]) => void) { this.listeners.get(event)?.delete(fn); return this; }
  removeAllListeners() { this.listeners.clear(); return this; }
  emit(event: string, data: any) { this.sent.push([event, data]); return this; }
  receive(event: string, data?: any) { for (const fn of [...this.listeners.get(event) ?? []]) fn(data); }
  disconnect() { this.connected = false; this.receive('disconnect', 'io client disconnect'); }
}
const manager = socketManager as any;
const owner = { id: 'user-1', dbUserId: 1, username: 'Owner', color: '#98D8C8', status: 'active', highestRole: 'member' };
const second = { ...owner, id: 'user-2', dbUserId: 2, username: 'Second' };
const third = { ...owner, id: 'user-3', dbUserId: 3, username: 'Third offline', status: 'offline' };
const general = { id: 'general', name: 'General', type: 'text', createdAt: 0 };
const group = (revision = '1', members = ['user-2', 'user-1']) => ({ id: 'group-test', name: 'Launch team', type: 'group',
  createdAt: 0, membershipRevision: revision, ownerId: 'user-1', members });
let fixture: FixtureSocket;
const callLifecycle: { event: string; ready?: boolean; listeners?: number }[] = [];
registerCallSocketOwner({
  disconnected: sock => { callLifecycle.push({ event: 'retired', listeners: (sock as any).listeners.size }); },
  initialized: () => { callLifecycle.push({ event: 'initialized', ready: groupMembership.ready() }); }
});
function install() {
  manager.destroySocket();
  fixture = new FixtureSocket();
  manager.socketInstance = fixture;
  manager.username = 'Owner';
  manager.state = 'connecting';
  socket.set(fixture as any);
  manager.bindEventListeners();
  fixture.receive('connect');
}
function init(value = group()) {
  fixture.receive('init', { channels: [general, value], users: [owner, second], serverMembers: [owner, second, third] });
}
function state() {
  return { channels: get(channels), messages: get(channelMessages), unread: get(unreadCount), counts: get(channelUnreadCounts),
    voice: get(voiceChannelMembers), typing: get(typingUsers), older: get(channelLoadingOlder),
    selected: get(selectedDmChannelId), center: get(centerDmChannelId), current: get(currentChannel), ready: groupMembership.ready() };
}
function seedViews() {
  channelMessages.set({ 'group-test': [{ id: 'secret' } as any], general: [{ id: 'public-canary' } as any] });
  unreadCount.set(5); channelUnreadCounts.set({ 'group-test': 3, general: 2 });
  voiceChannelMembers.set({ 'group-test': [{ id: 'old-member' } as any], voice: [{ id: 'voice-canary' } as any] });
  typingUsers.set({ 'group-test': ['Second'], general: ['Public'] });
  channelLoadingOlder.set({ 'group-test': true, general: false });
  selectedDmChannelId.set('group-test'); selectedGroupChannel.set(group() as any); centerDmChannelId.set('unrelated-dm');
  currentChannel.set('group-test');
}
setConfiguredServerUrl(location.origin, false);
setAuthToken(`eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ sub: '1', exp: 4102444800 }))}.fixture`);
setStoredDbUserId(1); setStoredUsername('Owner');
install(); init();
mount(GroupMembershipHarness, { target: document.querySelector('#harness')! });
(window as any).__group = {
  callLifecycle: () => callLifecycle,
  install, init, group, state, seedViews, joinChannel,
  receive: (event: string, payload: any) => fixture.receive(event, payload),
  sent: () => fixture.sent,
  clearSent: () => { fixture.sent = []; },
  retainPacket: (event: string, payload: any) => {
    const handlers = [...fixture.listeners.get(event) ?? []];
    return () => handlers.forEach(handler => handler(payload));
  },
  disconnect: () => fixture.disconnect(),
  async queue(type: string, clientMessageId: string) {
    const db = getWabiDB() || await openWabiDB();
    return db.enqueue({ type, scopeId: 'corechat', payload: { channelId: 'group-test', text: 'Draft', clientMessageId } });
  },
  async legacyQueue(type: string, id: string) {
    await openWabiDB();
    await new QueueDB().put(`corechat:${id}`, { id, key: `corechat:${id}`, scopeId: 'corechat', type,
      status: 'pending', payload: { channelId: 'group-test' }, createdAt: Date.now() });
  },
  queueState: () => getWabiDB()!.listQueue(), drain: drainOutboundQueue,
  retryQueue: () => getWabiDB()!.retryFailed(),
  raceClaim: (id: string) => Promise.all([new QueueManager().claimMessage(id), new QueueManager().claimMessage(id)]),
  beginInit: () => groupMembership.beginConnection(),
  logout: () => { setAuthToken(null); groupMembership.realm(); },
  close: () => { manager.destroySocket(); connected.set(false); }
};
