import { expect, test } from 'bun:test';
import { createAdminBadgeMutation, type AdminBadgeMutationState, type AdminBadgeSocket } from './adminBadgeMutation';

class SocketFixture implements AdminBadgeSocket {
	id = 'socket-1';
	connected = true;
	listeners = new Map<string, Set<(payload: any) => void>>();
	sent: { event: string; payload: any }[] = [];
	onEmit?: () => void;
	on(event: string, listener: (payload: any) => void) { const listeners = this.listeners.get(event) ?? new Set(); listeners.add(listener); this.listeners.set(event, listeners); }
	off(event: string, listener: (payload: any) => void) { this.listeners.get(event)?.delete(listener); }
	emit(event: string, payload: unknown) { this.sent.push({ event, payload }); this.onEmit?.(); }
	receive(event: string, payload?: unknown) { for (const listener of [...this.listeners.get(event) ?? []]) listener(payload); }
	listenerCount() { return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0); }
}

const member = { dbUserId: 2, username: 'Member' };
const badge = { id: 'founder', icon: 'crown', label: 'Founder' };
function fixture(socket = new SocketFixture(), requestId = 'request-1') {
	let state: AdminBadgeMutationState = { pending: null, error: '', status: '' };
	let targetAllowed = true;
	let timeout: (() => void) | null = null;
	let published = 0;
	const context = { server: 'https://one.test', actorId: 1, generation: 0, active: true, online: true, socket: socket as AdminBadgeSocket | null };
	const mutation = createAdminBadgeMutation({
		context: () => ({ ...context }),
		canManageTarget: () => targetAllowed,
		changed: next => { state = next; published++; },
		requestId: () => requestId,
		scheduleTimeout: callback => { timeout = callback; return () => { timeout = null; }; }
	});
	return { socket, mutation, context, get state() { return state; }, get published() { return published; },
		get timerActive() { return timeout !== null; }, expire: () => timeout?.(), denyTarget: () => { targetAllowed = false; } };
}

test('assign subscribes before emit and waits for the matching authoritative desired state', () => {
	const f = fixture();
	expect(f.mutation.change('assign', member, badge.id)).toBe(true);
	expect(f.socket.sent).toEqual([{ event: 'assign-badge', payload: { targetUserId: 2, badgeId: 'founder', requestId: 'request-1' } }]);
	expect(f.state.pending?.targetUserId).toBe(2);
	expect(f.state.status).toBe('');
	f.socket.receive('assign-badge-success', f.socket.sent[0].payload);
	for (const payload of [{ dbUserId: 3, badges: [badge] }, { dbUserId: '2', badges: [badge] }, { dbUserId: 2 }, { dbUserId: 2, badges: [null] }, { dbUserId: 2, badges: [] }]) {
		f.socket.receive('user-badges-updated', payload);
		expect(f.state.pending).not.toBeNull();
	}
	f.socket.receive('user-badges-updated', { dbUserId: 2, badges: [badge] });
	expect(f.state.pending).toBeNull();
	expect(f.state.status).toBe('Badge list updated for Member.');
	expect(f.socket.listenerCount()).toBe(0);
	expect(f.timerActive).toBe(false);
});

test('remove confirms absence only in a valid authoritative target update', () => {
	const f = fixture();
	f.socket.onEmit = () => f.socket.receive('user-badges-updated', { dbUserId: 2, badges: [] });
	expect(f.mutation.change('remove', member, badge.id)).toBe(true);
	expect(f.socket.sent[0].event).toBe('remove-badge');
	expect(f.state.pending).toBeNull();
	expect(f.state.status).toContain('updated');
	expect(f.socket.listenerCount()).toBe(0);
	expect(f.timerActive).toBe(false);
});

test('one pending command per socket prevents duplicate and second mounted editor sends', () => {
	const f = fixture(); const other = fixture(f.socket, 'request-2');
	f.mutation.change('assign', member, badge.id);
	expect(f.mutation.change('remove', member, badge.id)).toBe(false);
	expect(other.mutation.change('assign', { dbUserId: 3, username: 'Other' }, badge.id)).toBe(false);
	expect(other.state.error).toContain('in progress');
	expect(f.socket.sent).toHaveLength(1);
	f.mutation.dispose();
	expect(other.mutation.change('assign', member, badge.id)).toBe(true);
	other.mutation.dispose();
	expect(f.socket.listenerCount()).toBe(0);
});

test('offline/unauthorized commands never emit or install listeners', () => {
	for (const reason of ['offline', 'socket-offline', 'role-loss', 'target-loss']) {
		const f = fixture();
		if (reason === 'offline') f.context.online = false;
		if (reason === 'socket-offline') f.socket.connected = false;
		if (reason === 'role-loss') f.context.active = false;
		if (reason === 'target-loss') f.denyTarget();
		expect(f.mutation.change('assign', member, badge.id)).toBe(false);
		expect(f.state.error).not.toBe('');
		expect(f.socket.sent).toHaveLength(0);
		expect(f.socket.listenerCount()).toBe(0);
	}
});

test('only a matching request, target and badge may settle an error; legacy errors remain uncertain', () => {
	const f = fixture();
	f.mutation.change('assign', member, badge.id);
	const request = f.socket.sent[0].payload;
	for (const receipt of [{ error: 'Not authorized' }, { ...request, requestId: 'old' }, { ...request, targetUserId: 3 }, { ...request, badgeId: 'artist' }]) {
		f.socket.receive('assign-badge-error', { ...receipt, error: 'Not authorized' });
		expect(f.state.pending).not.toBeNull();
	}
	f.socket.receive('assign-badge-error', { ...request, error: 'Not authorized' });
	expect(f.state.pending).toBeNull();
	expect(f.state.error).toContain('did not allow');
	expect(f.state.status).toBe('');
	expect(f.socket.listenerCount()).toBe(0);
});

test('a retired visit releases its socket; its captured callback and late error cannot settle a replacement', () => {
	const old = fixture();
	old.mutation.change('assign', member, badge.id);
	const oldRequest = old.socket.sent[0].payload;
	const oldError = [...old.socket.listeners.get('assign-badge-error')!][0];
	const oldUpdate = [...old.socket.listeners.get('user-badges-updated')!][0];
	old.mutation.dispose();
	const oldPublished = old.published;
	const next = fixture(old.socket, 'new-request');
	expect(next.mutation.change('assign', member, badge.id)).toBe(true);
	old.socket.receive('assign-badge-error', { ...oldRequest, error: 'Not authorized' });
	oldError({ ...oldRequest, error: 'Not authorized' });
	oldUpdate({ dbUserId: 2, badges: [badge] });
	expect(next.state.pending).not.toBeNull();
	expect(old.published).toBe(oldPublished);
	next.socket.receive('user-badges-updated', { dbUserId: 2, badges: [badge] });
	expect(next.state.pending).toBeNull();
	expect(next.state.status).toContain('updated');
});

test('timeout is bounded and uncertain, never a fabricated rejection or success', () => {
	const f = fixture();
	f.mutation.change('remove', member, badge.id);
	f.expire();
	expect(f.state.pending).toBeNull();
	expect(f.state.error).toContain('could not be confirmed');
	expect(f.state.status).toBe('');
	expect(f.socket.listenerCount()).toBe(0);
	expect(f.timerActive).toBe(false);
	f.socket.receive('user-badges-updated', { dbUserId: 2, badges: [] });
	expect(f.state.status).toBe('');
});

test('disconnect, socket replacement and same-object socket-ID rollover retire pending work', () => {
	for (const reason of ['disconnect', 'replacement', 'id-rollover', 'auth-revoked']) {
		const f = fixture();
		f.mutation.change('assign', member, badge.id);
		if (reason === 'disconnect') { f.socket.connected = false; f.socket.receive('disconnect'); }
		if (reason === 'replacement') f.context.socket = new SocketFixture();
		if (reason === 'id-rollover') f.socket.id = 'socket-2';
		if (reason === 'auth-revoked') f.socket.receive('auth-revoked');
		f.mutation.reconcile();
		expect(f.state.pending).toBeNull();
		expect(f.state.error).toContain('Connection changed');
		expect(f.state.status).toBe('');
		expect(f.socket.listenerCount()).toBe(0);
	}
});

test('server/account/logout-login ABA boundaries clear old identity results and ignore late updates', () => {
	for (const boundary of ['server', 'actor', 'generation']) {
		const f = fixture();
		f.mutation.change('assign', member, badge.id);
		const staleUpdate = [...f.socket.listeners.get('user-badges-updated')!][0];
		if (boundary === 'server') f.context.server = 'https://two.test';
		if (boundary === 'actor') f.context.actorId = 10;
		if (boundary === 'generation') f.context.generation++;
		f.mutation.reconcile();
		staleUpdate({ dbUserId: 2, badges: [badge] });
		expect(f.state).toEqual({ pending: null, error: '', status: '' });
		expect(f.socket.listenerCount()).toBe(0);
		expect(f.timerActive).toBe(false);
	}
});

test('target permission loss during the request cannot produce a stale success', () => {
	const f = fixture();
	f.mutation.change('assign', member, badge.id);
	f.denyTarget();
	f.socket.receive('user-badges-updated', { dbUserId: 2, badges: [badge] });
	expect(f.state.pending).toBeNull();
	expect(f.state.error).toContain('could not be confirmed');
	expect(f.state.status).toBe('');
});
