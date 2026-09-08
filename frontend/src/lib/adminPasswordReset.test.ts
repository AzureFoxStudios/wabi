import { expect, test } from 'bun:test';
import { createAdminPasswordReset, validateAdminPassword, type PasswordResetContext, type PasswordResetState } from './adminPasswordReset';

function fixture(initialContext: Partial<PasswordResetContext> = {}) {
	let context: PasswordResetContext = { server: 'https://fixture.invalid', actorId: 1, generation: 0, token: 'fixture-token', allowed: true, ...initialContext };
	const states: PasswordResetState[] = [];
	const calls: unknown[][] = [];
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const response = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
	const controller = createAdminPasswordReset(2, {
		context: () => context,
		changed: (state) => states.push(state),
		reset: async (...args) => { calls.push(args); await response; }
	});
	return { controller, states, calls, resolve, reject, change: (patch: Partial<PasswordResetContext>) => { context = { ...context, ...patch }; } };
}

test('password reset validates confirmation and bcrypt UTF-8 limit before making any request', async () => {
	const f = fixture();
	for (const [password, confirmation] of [['short', 'short'], ['password8', 'different'], ['é'.repeat(37), 'é'.repeat(37)]]) {
		expect(await f.controller.submit(password, confirmation)).toBe(false);
	}
	expect(f.calls).toHaveLength(0);
	expect(validateAdminPassword('é'.repeat(36), 'é'.repeat(36))).toBeNull();
	expect(f.states.every((state) => !state.complete && !state.pending && state.error.length > 0)).toBe(true);
});

test('one server-confirmed reset has pending state, uses a permanent password and cannot duplicate', async () => {
	const f = fixture();
	const result = f.controller.submit('fixture-pass', 'fixture-pass');
	expect(f.states).toEqual([{ pending: true, error: '', complete: false }]);
	expect(await f.controller.submit('fixture-pass', 'fixture-pass')).toBe(false);
	expect(f.calls).toEqual([['fixture-token', 2, 'fixture-pass', false]]);
	f.resolve();
	expect(await result).toBe(true);
	expect(f.states.at(-1)).toEqual({ pending: false, error: '', complete: true });
	expect(await f.controller.submit('fixture-pass', 'fixture-pass')).toBe(false);
	expect(f.calls).toHaveLength(1);
	expect(JSON.stringify(f.states)).not.toContain('fixture-pass');
});

test('server failure never becomes success and does not disclose storage internals', async () => {
	const f = fixture();
	const result = f.controller.submit('fixture-pass', 'fixture-pass');
	f.reject(new Error('secret storage path and hash details'));
	expect(await result).toBe(false);
	expect(f.states.at(-1)?.complete).toBe(false);
	expect(f.states.at(-1)?.pending).toBe(false);
	expect(f.states.at(-1)?.error).toContain('could not be confirmed');
	expect(JSON.stringify(f.states)).not.toContain('secret');
});

test('revoked permission, missing session, realm change and self-target all prevent sending', async () => {
	for (const context of [{ allowed: false }, { token: null }, { server: 'https://other.invalid' }, { actorId: 3 }, { actorId: 2 }]) {
		const f = fixture();
		f.change(context);
		expect(await f.controller.submit('fixture-pass', 'fixture-pass')).toBe(false);
		expect(f.calls).toHaveLength(0);
	}
	const self = fixture({ actorId: 2 });
	expect(await self.controller.submit('fixture-pass', 'fixture-pass')).toBe(false);
	expect(self.calls).toHaveLength(0);
});

test('late completion cannot publish after dialog closes, account/server change, logout, or demotion', async () => {
	for (const change of ['dispose', 'account', 'server', 'logout', 'demotion']) {
		const f = fixture();
		const result = f.controller.submit('fixture-pass', 'fixture-pass');
		if (change === 'dispose') f.controller.dispose();
		if (change === 'account') f.change({ actorId: 3 });
		if (change === 'server') f.change({ server: 'https://other.invalid' });
		if (change === 'logout') f.change({ token: null });
		if (change === 'demotion') f.change({ allowed: false });
		f.resolve();
		expect(await result).toBe(false);
		expect(f.states).toHaveLength(1);
		expect(f.states[0].complete).toBe(false);
	}
});

test('refreshing the same admin session preserves an in-flight acknowledgement', async () => {
	const f = fixture();
	const result = f.controller.submit('fixture-pass', 'fixture-pass');
	f.change({ token: 'refreshed-fixture-token' });
	f.resolve();
	expect(await result).toBe(true);
});

test('same-account logout and login cannot accept the previous session’s pending reset', async () => {
	const f = fixture();
	const result = f.controller.submit('fixture-pass', 'fixture-pass');
	f.change({ token: 'new-session-same-user', generation: 1 });
	f.resolve();
	expect(await result).toBe(false);
	expect(f.states).toEqual([{ pending: true, error: '', complete: false }]);
});

test('a dialog opened before a same-account session boundary cannot issue a reset afterwards', async () => {
	const f = fixture();
	f.change({ token: 'new-session-same-user', generation: 1 });
	expect(await f.controller.submit('fixture-pass', 'fixture-pass')).toBe(false);
	expect(f.calls).toHaveLength(0);
});
