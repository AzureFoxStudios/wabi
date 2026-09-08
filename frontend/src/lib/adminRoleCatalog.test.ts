import { describe, expect, test } from 'bun:test';
import { createAdminRoleCatalog, parseAdminRoleCatalog, type AdminRoleCatalogState } from './adminRoleCatalog';
import { applyServerRoleUpdate, parseServerRoleUpdate } from './serverRoleUpdates';
import { requestServerRoleChange } from './serverRoleCommands';

class SocketFixture {
	connected = true;
	listeners = new Map<string, Set<(payload: any) => void>>();
	sent: { event: string; payload: any }[] = [];
	onEmit?: (event: string) => void;
	on(event: string, fn: (payload: any) => void) { const set = this.listeners.get(event) ?? new Set(); set.add(fn); this.listeners.set(event, set); }
	off(event: string, fn: (payload: any) => void) { this.listeners.get(event)?.delete(fn); }
	emit(event: string, payload?: unknown) { this.sent.push({ event, payload }); this.onEmit?.(event); }
	receive(event: string, payload?: unknown) { for (const fn of this.listeners.get(event) ?? []) fn(payload); }
	count() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}

const owner = { roleName: 'owner', displayName: 'Owner', priority: 400 };
const member = { roleName: 'member', displayName: 'Member', priority: 100 };

describe('admin role catalog lifecycle', () => {
	test('validates wire shape without inventing roles from legacy channel permission records', () => {
		expect(parseAdminRoleCatalog({ roles: [member, owner] })?.map(role => role.roleName)).toEqual(['owner', 'member']);
		expect(parseAdminRoleCatalog({ roles: [] })).toEqual([]);
		for (const payload of [null, {}, { roles: [{ role: 'Admin', channel_id: 'default-workspace', permissions: 3 }] }, { roles: [owner, owner] }]) {
			expect(parseAdminRoleCatalog(payload)).toBeNull();
		}
	});
	test('subscribes before request, and real empty responses finish loading', () => {
		const socket = new SocketFixture();
		let state!: AdminRoleCatalogState;
		const catalog = createAdminRoleCatalog(next => { state = next; });
		socket.onEmit = () => socket.receive('role-definitions-updated', { roles: [] });
		catalog.bind(socket);
		expect(state).toEqual({ roles: [], loading: false, error: '' });
		catalog.dispose();
		expect(socket.count()).toBe(0);
	});
	test('reconnect clears old authority, removes listeners, and ignores captured stale callbacks', () => {
		const old = new SocketFixture(); const next = new SocketFixture();
		let state!: AdminRoleCatalogState;
		const catalog = createAdminRoleCatalog(value => { state = value; });
		catalog.bind(old);
		const stale = [...old.listeners.get('role-definitions-updated')!][0];
		old.receive('role-definitions-updated', { roles: [owner] });
		catalog.bind(null);
		expect(state.roles).toEqual([]);
		expect(state.error).toContain('Reconnect');
		catalog.bind(next);
		stale({ roles: [owner] });
		expect(state.roles).toEqual([]);
		next.receive('role-definitions-updated', { roles: [member] });
		expect(state.roles[0].roleName).toBe('member');
		catalog.dispose();
		expect(old.count() + next.count()).toBe(0);
	});
	test('timeout is actionable and explicit retry can recover', async () => {
		const socket = new SocketFixture(); let state!: AdminRoleCatalogState;
		const catalog = createAdminRoleCatalog(value => { state = value; }, 1);
		catalog.bind(socket);
		await new Promise(resolve => setTimeout(resolve, 5));
		expect(state.loading).toBe(false); expect(state.error).toContain('did not respond');
		catalog.refresh(); socket.receive('role-definitions-updated', { roles: [owner] });
		expect(state.error).toBe(''); expect(state.roles).toHaveLength(1);
		catalog.dispose();
	});
});

describe('server role identity updates', () => {
	test('only changes the target role, never another account profile or online state', () => {
		const me = { id: 'user-1', dbUserId: 1, highestRole: 'owner' as const, profilePicture: 'mine', status: 'active' };
		const offline = { id: 'user-2', dbUserId: 2, highestRole: 'member', roles: ['member'], profilePicture: 'theirs', status: 'offline' };
		const update = parseServerRoleUpdate({ dbUserId: 2, highestRole: 'admin', profilePicture: 'do not merge' })!;
		expect(applyServerRoleUpdate(me, update)).toBe(me);
		expect(applyServerRoleUpdate(offline, update)).toEqual({ ...offline, highestRole: 'admin', roles: ['admin'] });
		expect(parseServerRoleUpdate({ dbUserId: 2, highestRole: 'superadmin' })).toBeNull();
		expect(parseServerRoleUpdate({ dbUserId: '2', highestRole: 'admin' })).toBeNull();
	});
});

describe('server-confirmed role commands', () => {
	const options = { isCurrent: () => true, onInvalidated: () => () => {}, requestId: 'command-1' };
	test('emitting is not success and unrelated receipts cannot settle the request', async () => {
		const socket = new SocketFixture(); let settled = false;
		const pending = requestServerRoleChange(socket, 2, 'mod', options).then(() => { settled = true; });
		expect(socket.sent).toEqual([{ event: 'assign-role', payload: { targetUserId: 2, roleName: 'mod', requestId: 'command-1' } }]);
		socket.receive('assign-role-success', { targetUserId: 2, role: 'Moderator', requestId: 'other' });
		await Promise.resolve(); expect(settled).toBe(false);
		socket.receive('assign-role-success', { targetUserId: 2, role: 'Moderator', requestId: 'command-1' });
		await pending; expect(settled).toBe(true); expect(socket.count()).toBe(0);
	});
	test('rejects concurrent replacements of one target and confirms direct Member reset', async () => {
		const socket = new SocketFixture();
		const first = requestServerRoleChange(socket, 2, 'member', options);
		await expect(requestServerRoleChange(socket, 2, 'admin', options)).rejects.toThrow('already in progress');
		expect(socket.sent).toHaveLength(1);
		socket.receive('assign-role-success', { targetUserId: 2, role: 'Member', requestId: 'command-1' });
		await first;
	});
	test('rejects offline grants, unknown roles, and explicit server denial without queueing', async () => {
		const socket = new SocketFixture(); socket.connected = false;
		await expect(requestServerRoleChange(socket, 2, 'admin', options)).rejects.toThrow('Reconnect');
		socket.connected = true;
		await expect(requestServerRoleChange(socket, 2, 'owner', options)).rejects.toThrow('valid member');
		expect(socket.sent).toHaveLength(0);
		const pending = requestServerRoleChange(socket, 2, 'admin', options);
		socket.receive('assign-role-error', { requestId: 'command-1', error: 'Only admins can assign roles' });
		await expect(pending).rejects.toThrow('Only admins'); expect(socket.count()).toBe(0);
	});
	test('fences replaced sockets/realms and late success after disconnect', async () => {
		const socket = new SocketFixture(); let current = true;
		const pending = requestServerRoleChange(socket, 2, 'admin', { ...options, isCurrent: () => current });
		current = false;
		socket.receive('assign-role-success', { requestId: 'command-1', targetUserId: 2, role: 'Admin' });
		await expect(pending).rejects.toThrow('Connection changed');
		expect(socket.count()).toBe(0);
	});
	test('times out honestly and cleans up all waiters', async () => {
		const socket = new SocketFixture();
		await expect(requestServerRoleChange(socket, 2, 'admin', { ...options, timeoutMs: 1 })).rejects.toThrow('did not confirm');
		expect(socket.count()).toBe(0);
	});
});
