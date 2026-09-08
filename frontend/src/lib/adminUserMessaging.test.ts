import { expect, test } from 'bun:test';
import { createAdminUserMessaging } from './adminUserMessaging';
import type { Channel, User } from './socket-types';
import type { CreateDMResult } from './socket';

const self = { id: 'self-socket', dbUserId: 1, username: 'Admin', color: '#fff', status: 'active' } as User;
const member = { id: 'member-socket', dbUserId: 2, username: 'Member', color: '#fff', status: 'offline' } as User;
const dm = { id: 'dm-existing', type: 'dm', members: ['user-1', 'user-2'] } as Channel;

function fixture(initialChannels: Channel[] = []) {
	let context = { server: 'fixture-a', generation: 0, self: self as User | null, online: true, active: true, channels: initialChannels };
	const events: Array<{ name: string; data?: unknown }> = [];
	let resolve!: (result: CreateDMResult) => void;
	let reject!: (error: Error) => void;
	const response = new Promise<CreateDMResult>((yes, no) => { resolve = yes; reject = no; });
	const controller = createAdminUserMessaging({
		context: () => context,
		create: async (id) => { events.push({ name: 'create', data: id }); return response; },
		open: (id, user) => events.push({ name: 'open-right', data: [id, user] }),
		join: (id) => events.push({ name: 'join', data: id }),
		openNotes: () => events.push({ name: 'notes' }),
		leaveAdmin: () => events.push({ name: 'leave-admin' }),
		changed: (state) => events.push({ name: 'state', data: state })
	});
	return { controller, events, resolve, reject, change: (patch: Partial<typeof context>) => { context = { ...context, ...patch }; } };
}

test('existing DM uses stable identity, opens the selected person, joins room, then leaves Admin', async () => {
	const f = fixture([dm]);
	expect(await f.controller.open(member)).toBe(true);
	expect(f.events.filter((event) => event.name !== 'state')).toEqual([
		{ name: 'open-right', data: ['dm-existing', member] },
		{ name: 'join', data: 'dm-existing' },
		{ name: 'leave-admin' }
	]);
});

test('new DM waits for creation using canonical stable target and coalesces repeated clicks', async () => {
	const f = fixture();
	const pending = f.controller.open(member);
	expect(await f.controller.open(member)).toBe(false);
	expect(f.events.filter((event) => event.name !== 'state')).toEqual([{ name: 'create', data: 'user-2' }]);
	f.resolve({ ok: true, channelId: 'dm-created' });
	expect(await pending).toBe(true);
	expect(f.events.slice(-3)).toEqual([
		{ name: 'open-right', data: ['dm-created', member] },
		{ name: 'join', data: 'dm-created' },
		{ name: 'leave-admin' }
	]);
});

test('creation failure does not open a claimed unrelated channel or leave the admin workspace', async () => {
	const f = fixture();
	const pending = f.controller.open(member);
	f.resolve({ ok: false, error: 'Permission denied', channelId: 'dm-someone-else' });
	expect(await pending).toBe(false);
	expect(f.events.some((event) => ['open-right', 'join', 'leave-admin'].includes(event.name))).toBe(false);
	expect(f.events.at(-1)).toEqual({ name: 'state', data: { pendingUserId: null, error: 'Permission denied' } });
});

test('matching channel that arrives while creation is pending is reused', async () => {
	const f = fixture();
	const pending = f.controller.open(member);
	f.change({ channels: [dm] });
	f.resolve({ ok: false, error: 'DM already exists', channelId: dm.id });
	expect(await pending).toBe(true);
	expect(f.events.find((event) => event.name === 'open-right')?.data).toEqual([dm.id, member]);
});

test('late DM creation cannot hijack navigation after section closes, realm/account changes, or disposal', async () => {
	for (const retire of ['section', 'realm', 'account', 'logout', 'dispose']) {
		const f = fixture();
		const pending = f.controller.open(member);
		if (retire === 'section') f.change({ active: false });
		if (retire === 'realm') f.change({ server: 'fixture-b' });
		if (retire === 'account') f.change({ self: { ...self, dbUserId: 3 } });
		if (retire === 'logout') f.change({ self: null });
		if (retire === 'dispose') f.controller.dispose();
		const before = f.events.length;
		f.resolve({ ok: true, channelId: 'dm-late' });
		expect(await pending).toBe(false);
		expect(f.events).toHaveLength(before);
	}
});

test('offline new conversation is rejected, while existing history still opens', async () => {
	const fresh = fixture();
	fresh.change({ online: false });
	expect(await fresh.controller.open(member)).toBe(false);
	expect(fresh.events.some((event) => event.name === 'create')).toBe(false);
	const existing = fixture([dm]);
	existing.change({ online: false });
	expect(await existing.controller.open(member)).toBe(true);
});

test('self under another socket identity opens Notes without creating or joining a DM', async () => {
	const f = fixture();
	expect(await f.controller.open({ ...self, id: 'self-other-tab' })).toBe(true);
	expect(f.events).toEqual([{ name: 'notes' }, { name: 'leave-admin' }]);
});

test('thrown transport failure settles pending state without navigation or raw error leakage', async () => {
	const f = fixture();
	const pending = f.controller.open(member);
	f.reject(new Error('internal transport details'));
	expect(await pending).toBe(false);
	expect(f.events.some((event) => event.name === 'leave-admin')).toBe(false);
	expect(JSON.stringify(f.events.at(-1))).toContain('Check your connection');
	expect(JSON.stringify(f.events.at(-1))).not.toContain('internal transport');
});

test('same-account logout and login cannot open a DM created by the retired session', async () => {
	const f = fixture();
	const pending = f.controller.open(member);
	const before = f.events.length;
	f.change({ generation: 1, self: { ...self, id: 'new-socket-same-account' } });
	f.resolve({ ok: true, channelId: 'old-session-result' });
	expect(await pending).toBe(false);
	expect(f.events).toHaveLength(before);
});

test('same-session reconnect changes socket identity without retiring a valid pending DM', async () => {
	const f = fixture();
	const pending = f.controller.open(member);
	f.change({ self: { ...self, id: 'reconnected-same-session' } });
	f.resolve({ ok: true, channelId: 'current-session-result' });
	expect(await pending).toBe(true);
	expect(f.events.at(-1)?.name).toBe('leave-admin');
});
