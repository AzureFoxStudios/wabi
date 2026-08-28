import { describe, expect, test, mock } from 'bun:test';

mock.module('$lib/api', () => ({ getPaymentAccess: async () => ({ success: true, policy: null }) }));
// 2026-08-27: with tsconfig paths, bun resolves '$lib/authSession' to the
// real module — this mock now SHADOWS it for every later importer in the
// process (e.g. api/authRefresh needs setAuthToken). Provide the full
// surface the auth graph imports.
mock.module('$lib/authSession', () => ({
	getAuthToken: () => 'test-token',
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

const { canConfirmDisable, resolvePaymentAccessSnapshot, DISABLE_CONFIRM_PHRASE } = await import(
	'./paymentAccessStore'
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
			{ enabled: true, allowGuest: false, allowedRoleNames: [] },
			'token'
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