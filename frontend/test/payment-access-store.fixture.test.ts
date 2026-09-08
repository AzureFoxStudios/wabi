import { describe, expect, test, mock } from 'bun:test';
import { get } from 'svelte/store';

let activeToken = 'test-token';
let server = 'https://payments.test';
let sessionGeneration = 0;
let clearSession: (server: string) => void = () => {};
let loadAccess: () => Promise<any> = async () => ({ success: true, policy: null });

mock.module('$lib/api', () => ({ getPaymentAccess: () => loadAccess() }));
mock.module('../src/lib/serverUrl', () => ({ getServerUrl: () => server, normalizeServerUrl: (value: string) => value }));
// This fixture runs in its own Bun process: mocking auth, server selection
// and API timing must not replace those modules for unrelated test suites.
mock.module('$lib/authSession', () => ({
	getAuthToken: () => activeToken,
	authSessionGeneration: () => sessionGeneration,
	onAuthSessionCleared: (listener: (server: string) => void) => { clearSession = listener; return () => {}; },
	setAuthToken: () => {},
	setPersistentAuthToken: () => {},
	clearAuthToken: () => {},
	getGuestSessionId: () => null,
	setGuestSessionId: () => {},
	clearGuestSessionId: () => {},
	getStoredUsername: () => null,
	setStoredUsername: () => {},
	clearStoredUsername: () => {},
	getStoredDbUserId: () => null,
	setStoredDbUserId: () => {},
	clearStoredDbUserId: () => {},
	hydrateServerScope: () => {},
	transferServerScopeSession: () => {}
}));

const { canConfirmDisable, resolvePaymentAccessSnapshot, DISABLE_CONFIRM_PHRASE, refreshPaymentAccess, paymentAccessStore } = await import(
	'../src/lib/payments/paymentAccessStore'
);

describe('resolvePaymentAccessSnapshot', () => {
	test('fail-CLOSED when policy is unknown (2026-08-27 owner directive: payments disabled ⇒ omit all payment UI)', () => {
		const snap = resolvePaymentAccessSnapshot(null, 'token');
		expect(snap.loaded).toBe(true);
		expect(snap.policyEnabled).toBe(false);
		expect(snap.canViewPaymentUi).toBe(false);
		expect(snap.canCreate).toBe(false);
	});

	test('fail-closed keeps guests blocked too', () => {
		const snap = resolvePaymentAccessSnapshot(null, null);
		expect(snap.canViewPaymentUi).toBe(false);
		expect(snap.canCreate).toBe(false);
	});

	test('enabled policy: UI visible and creation allowed for authenticated users', () => {
		const snap = resolvePaymentAccessSnapshot(
			{ enabled: true, allowGuest: false, allowedRoleNames: ['member'] },
			'token',
			{ authenticated: true, userId: 1, roles: ['member'], blocked: false, canCreate: true, reasonCode: null, reason: null }
		);
		expect(snap.policyEnabled).toBe(true);
		expect(snap.canViewPaymentUi).toBe(true);
		expect(snap.canCreate).toBe(true);
	});

	test('disabled policy: UI hidden and creation blocked even when authenticated', () => {
		const snap = resolvePaymentAccessSnapshot(
			{ enabled: false, allowGuest: false, allowedRoleNames: [] },
			'token'
		);
		expect(snap.policyEnabled).toBe(false);
		expect(snap.canViewPaymentUi).toBe(false);
		expect(snap.canCreate).toBe(false);
	});

	test('missing or blocked actor cannot grant creation; disabled always hides UI', () => {
		const policy = { enabled: true, allowGuest: false, allowedRoleNames: ['member'] };
		expect(resolvePaymentAccessSnapshot(policy, 'token').canCreate).toBe(false);
		const actor = { authenticated: true, userId: 1, roles: ['member'], blocked: true, canCreate: true, reasonCode: 'blocked', reason: 'Blocked' };
		expect(resolvePaymentAccessSnapshot(policy, 'token', actor).canCreate).toBe(false);
		expect(resolvePaymentAccessSnapshot({ ...policy, enabled: false }, 'token', { ...actor, blocked: false }).canViewPaymentUi).toBe(false);
	});
});

describe('payment access refresh ownership', () => {
	test('late old-account response cannot replace a newer decision', async () => {
		let finishOld!: (value: any) => void;
		loadAccess = () => new Promise(resolve => { finishOld = resolve; });
		const old = refreshPaymentAccess();
		expect(refreshPaymentAccess()).toBe(old);
		activeToken = 'replacement-account';
		loadAccess = async () => ({ policy: { enabled: false, allowGuest: false, allowedRoleNames: [] }, actor: null });
		await refreshPaymentAccess();
		finishOld({ policy: { enabled: true, allowGuest: false, allowedRoleNames: [] }, actor: { authenticated: true, blocked: false, canCreate: true } });
		await old;
		expect(get(paymentAccessStore).policyEnabled).toBe(false);
		expect(get(paymentAccessStore).canCreate).toBe(false);
	});

	test('logout clears a confirmed grant and fences an in-flight response, even after same-account login', async () => {
		const allowed = { policy: { enabled: true, allowGuest: false, allowedRoleNames: ['member'] }, actor: { authenticated: true, blocked: false, canCreate: true } };
		loadAccess = async () => allowed;
		await refreshPaymentAccess();
		expect(get(paymentAccessStore).canCreate).toBe(true);
		let finish!: (value: any) => void;
		loadAccess = () => new Promise(resolve => { finish = resolve; });
		const pending = refreshPaymentAccess();
		sessionGeneration += 1;
		clearSession(server);
		finish(allowed);
		await pending;
		expect(get(paymentAccessStore).loaded).toBe(false);
		expect(get(paymentAccessStore).canCreate).toBe(false);
	});

	test('a server switch rejects the old server response', async () => {
		let finish!: (value: any) => void;
		loadAccess = () => new Promise(resolve => { finish = resolve; });
		const pending = refreshPaymentAccess();
		server = 'https://another-payments.test';
		finish({ policy: { enabled: true, allowGuest: false, allowedRoleNames: [] }, actor: { authenticated: true, blocked: false, canCreate: true } });
		await pending;
		expect(get(paymentAccessStore).canCreate).toBe(false);
	});
});

describe('canConfirmDisable', () => {
	test('requires both acknowledgment and exact phrase', () => {
		expect(canConfirmDisable(false, DISABLE_CONFIRM_PHRASE)).toBe(false);
		expect(canConfirmDisable(true, '')).toBe(false);
		expect(canConfirmDisable(true, 'DISABLED')).toBe(false);
		expect(canConfirmDisable(true, 'DISABLE')).toBe(true);
	});

	test('phrase match is case-insensitive and trims whitespace', () => {
		expect(canConfirmDisable(true, '  disable  ')).toBe(true);
		expect(canConfirmDisable(true, 'DISABLED')).toBe(false);
	});
});
