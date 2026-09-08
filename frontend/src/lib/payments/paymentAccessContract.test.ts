import { describe, expect, test } from 'bun:test';
import { parsePaymentAccessResponse, paymentAccountKey } from './paymentAccessContract';

const policy = { enabled: true, allowGuest: false, allowedRoleNames: ['member'] };
const actor = { authenticated: true, userId: 42, roles: ['member'], blocked: false, canCreate: true, reasonCode: null, reason: null };

describe('server payment access contract', () => {
  test('preserves the actual actor and rejection reason', () => {
    const denied = { ...actor, blocked: true, canCreate: false, reasonCode: 'blocked', reason: 'Account blocked' };
    expect(parsePaymentAccessResponse({ success: true, policy, actor: denied }).actor).toEqual(denied);
    expect(parsePaymentAccessResponse({ success: true, policy, actor }).actor).toEqual(actor);
  });
  test('disabled, missing, unauthenticated and inconsistent actors cannot grant creation', () => {
    for (const value of [undefined, {}, { ...actor, authenticated: false }, { ...actor, blocked: true }, { ...actor, canCreate: 'true' }, { ...actor, userId: null }]) {
      expect(parsePaymentAccessResponse({ success: true, policy, actor: value }).actor.canCreate).toBe(false);
    }
    expect(parsePaymentAccessResponse({ success: true, policy: { ...policy, enabled: false }, actor }).actor.canCreate).toBe(false);
    expect(parsePaymentAccessResponse({ success: true, policy: { ...policy, allowedRoleNames: [] }, actor }).actor.canCreate).toBe(false);
  });
  test('rejects malformed policy and unsuccessful response rather than inventing defaults', () => {
    for (const value of [null, {}, { success: false, policy }, { success: true }, { success: true, policy: { ...policy, enabled: 'false' } }]) {
      expect(() => parsePaymentAccessResponse(value)).toThrow('Invalid payment access response');
    }
  });
  test('token renewal preserves identity, not account/server/session authority', () => {
    const token = (sub: string, jti: string) => `header.${btoa(JSON.stringify({ sub, jti, is_guest: false }))}.signature`;
    expect(paymentAccountKey(token('42', 'old'))).toBe(paymentAccountKey(token('42', 'renewed')));
    expect(paymentAccountKey(token('42', 'old'))).not.toBe(paymentAccountKey(token('43', 'other')));
    expect(paymentAccountKey('opaque-a')).not.toBe(paymentAccountKey('opaque-b'));
  });
});
