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
import { voiceChannelMembers, banUser } from '../src/lib/presenceStore';
import { typingUsers } from '../src/lib/typingStore';
import { selectedDmChannelId, selectedGroupChannel, centerDmChannelId } from '../src/lib/layoutStoreStates';
import { groupMembership } from '../src/lib/groupAccess';
import { openWabiDB, getWabiDB } from '../src/lib/wabidb';
import { QueueDB } from '../src/lib/wabidb/queue/db';
import { drainOutboundQueue } from '../src/lib/wabidb/drain';
import { QueueManager } from '../src/lib/wabidb/queue/manager';
import { registerCallSocketOwner } from '../src/lib/callSocketLifecycle';
import { currentUser, users, serverMembers } from '../src/lib/presenceIdentity';
import { buildUserMenuItems } from '../src/lib/components/userListHelpers';
import { messageDeliveryContract } from './message-delivery-contract';

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
	messageDeliveryContract: () => messageDeliveryContract({ socket: () => fixture, install, init, owner }),
	unsupportedBanContract: async () => {
		const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
		const db = getWabiDB() || await openWabiDB();
		const raw = new QueueDB();
		const pendingId = `unsupported-ban-pending-${crypto.randomUUID()}`;
		const failedId = `unsupported-ban-failed-${crypto.randomUUID()}`;
		const start = fixture.sent.length;
		try {
			for (const role of ['owner', 'admin', 'mod', 'member', 'guest']) {
				const menu = buildUserMenuItems({ contextMenuUser: { ...second, isRegistered: true } as any,
					currentUser: { ...owner, highestRole: role } as any, rolePriority: { owner: 400, admin: 300, mod: 200, member: 100, guest: 0 },
					localNicknamesEnabled: false, hasLocalNickname: false, socket: fixture });
				assert(!menu.some(item => item.id === 'ban-user'), `${role} menu offered an unsupported Ban`);
			}
			let apiRejected = false;
			try { await banUser(2, 'canary'); }
			catch (error) { apiRejected = error instanceof Error && error.message.includes('No account access was changed'); }
			assert(apiRejected, 'compatibility Ban API silently succeeded');
			let enqueueRejected = false;
			try { await db.enqueue({ type: 'ban-user', scopeId: 'corechat', payload: { targetUserId: 2 } }); }
			catch (error) { enqueueRejected = error instanceof Error && error.message.includes('bans are not available'); }
			assert(enqueueRejected, 'unsupported Ban was accepted by the offline queue');
			for (const [id, status] of [[pendingId, 'pending'], [failedId, 'failed']] as const) {
				await raw.put(`corechat:${id}`, { id, key: `corechat:${id}`, scopeId: 'corechat', type: 'ban-user', status,
					payload: { targetUserId: 2 }, createdAt: Date.now() });
			}
			await db.retryFailed();
			const oldFailure = (await db.listQueue()).find(action => action.id === failedId);
			assert(oldFailure?.status === 'failed' && oldFailure.retryable === false, 'Retry revived an old failed Ban');
			await drainOutboundQueue();
			await db.retryFailed();
			for (const id of [pendingId, failedId]) {
				const row = (await db.listQueue()).find(action => action.id === id);
				assert(row?.status === 'failed' && row.retryable === false, 'old Ban was deleted, synced or made retryable');
				assert(row?.error?.includes('did not revoke account access') === true, 'old Ban had no truthful failure reason');
			}
			assert(!fixture.sent.slice(start).some(([event]) => event === 'ban-user'), 'unsupported Ban reached transport');
			return true;
		} finally {
			// These are fixture-created records only, never pre-existing user data.
			await raw.delete(`corechat:${pendingId}`); await raw.delete(`corechat:${failedId}`);
		}
	},
	profileIdentityContract: () => {
		const previous = { current: get(currentUser), users: get(users), members: get(serverMembers) };
		const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
		try {
			const self = { ...owner, id: 'previous-self-transport', roles: ['member'], profilePicture: 'self-avatar', bio: 'self-bio' };
			currentUser.set(self as any);
			for (const event of ['user-updated', 'profile-updated']) {
				fixture.receive(event, { ...second, profilePicture: 'peer-avatar', bio: 'peer-bio' });
				assert(get(currentUser)?.profilePicture === 'self-avatar', `${event} changed another account's avatar`);
				assert(get(currentUser)?.bio === 'self-bio', `${event} changed another account's bio`);
				assert(get(serverMembers).find(user => user.dbUserId === 2)?.profilePicture === 'peer-avatar', `${event} did not update the peer roster`);
			}
			fixture.receive('user-updated', { ...owner, profilePicture: 'updated-self', bio: 'updated-bio' });
			assert(get(currentUser)?.profilePicture === 'updated-self', 'stable self identity did not update across transport IDs');
			fixture.receive('profile-updated', { ...owner, profilePicture: null, bio: 'own-save' });
			assert(get(currentUser)?.profilePicture === null && get(currentUser)?.bio === 'own-save', 'own save must still clear/update profile fields');
			fixture.receive('user-role-updated', { dbUserId: 2, highestRole: 'admin' });
			assert(get(currentUser)?.highestRole === 'member', 'another role update changed self');
			fixture.receive('user-role-updated', { dbUserId: 1, highestRole: 'admin' });
			assert(get(currentUser)?.highestRole === 'admin' && get(currentUser)?.bio === 'own-save', 'own role update must preserve profile fields');
			currentUser.set({ ...owner, id: fixture.id, dbUserId: undefined } as any);
			fixture.receive('profile-updated', { ...owner, id: fixture.id, dbUserId: undefined, profilePicture: 'socket-self' });
			assert(get(currentUser)?.profilePicture === 'socket-self', 'provisional own socket profile did not update');
			const context = { currentUser: { ...owner, highestRole: 'owner' } as any, rolePriority: { owner: 400, member: 100, guest: 0 },
				localNicknamesEnabled: false, hasLocalNickname: false, socket: fixture };
			const guestMenu = buildUserMenuItems({ ...context, contextMenuUser: { ...second, isRegistered: false } as any });
			const memberMenu = buildUserMenuItems({ ...context, contextMenuUser: { ...second, isRegistered: true } as any });
			assert(!guestMenu.some(item => ['make-admin', 'make-mod', 'remove-admin', 'remove-mod', 'reset-member'].includes(item.id!)), 'guest menu offered unsupported role changes');
			assert(memberMenu.some(item => item.id === 'make-admin'), 'registered member role action disappeared');
			return true;
		} finally {
			currentUser.set(previous.current); users.set(previous.users); serverMembers.set(previous.members);
		}
	},
	currentProfile: () => get(currentUser),
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
