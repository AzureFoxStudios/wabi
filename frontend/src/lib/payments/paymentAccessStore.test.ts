import { describe, expect, test, mock } from 'bun:test';

mock.module('$lib/api', () => ({ getPaymentAccess: async () => ({ success: true, policy: null }) }));
mock.module('$lib/authSession', () => ({ getAuthToken: () => 'test-token' }));

const { canConfirmDisable, resolvePaymentAccessSnapshot, DISABLE_CONFIRM_PHRASE } = await import(
	'./paymentAccessStore'
);

describe('resolvePaymentAccessSnapshot', () => {
	test('fail-open when policy is unknown (null): UI visible, creation auth-gated', () => {
		const snap = resolvePaymentAccessSnapshot(null, 'token');
		expect(snap.loaded).toBe(true);
		expect(snap.policyEnabled).toBe(false);
		expect(snap.canViewPaymentUi).toBe(true);
		expect(snap.canCreate).toBe(true);
	});

	test('fail-open keeps guests blocked', () => {
		const snap = resolvePaymentAccessSnapshot(null, null);
		expect(snap.canViewPaymentUi).toBe(true);
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