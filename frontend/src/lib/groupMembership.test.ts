import { describe, expect, test } from 'bun:test';
import { GroupMembership, membershipRevision, type MembershipContext } from './groupMembership';
import type { Channel } from './socket-types';
import { groupQueueDecision } from './wabidb/queue/groupPolicy';
import type { QueuedAction } from './wabidb/types';

const group = (revision = '9007199254740993', members = ['user-2', 'user-1']): Channel => ({
  id: 'group-test', name: 'Project', type: 'group', createdAt: 0, ownerId: 'user-1', membershipRevision: revision, members
});
function fixture() {
  let context: MembershipContext | null = { server: 'https://one.example', account: '1' };
  const stored = new Map<string, string>();
  const deps = { context: () => context, storage: {
    getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }
  }};
  const membership = new GroupMembership(deps);
  const realm = membership.realm()!;
  return { membership, realm, deps, setContext: (value: MembershipContext | null) => { context = value; } };
}

describe('account/server-scoped group lifecycle', () => {
  test('revision stays exact above JS safe integer range and validates u64', () => {
    for (const bad of [1, '01', '-1', '1.0', '1e3', '', '18446744073709551616']) expect(membershipRevision(bad)).toBeNull();
    expect(membershipRevision('18446744073709551615')).toBe('18446744073709551615');
  });
  test('unknown groups are fenced, public channels remain usable, owner is explicit', () => {
    const { membership: m, realm } = fixture();
    expect(m.acceptsContent('general')).toBe(true);
    expect(m.acceptsContent('group-test')).toBe(false);
    expect(() => m.capture('group-test')).toThrow();
    expect(m.apply(group(), realm)).toBe(true); // owner is NOT members[0]
    expect(m.ready()).toBe(false);
    m.finishInit(realm); expect(m.ready()).toBe(true);
    m.beginConnection(); expect(m.ready()).toBe(false);
    expect(m.acceptsContent('group-test')).toBe(true); // offline cache is still readable
  });
  test('late snapshots cannot undo removal; explicit newer re-add cannot revive old leases', () => {
    const { membership: m, realm } = fixture();
    m.apply(group(), realm);
    const lease = m.capture('group-test');
    const unrelated = m.capture('general');
    const events: string[] = [];
    m.onRevoked(event => events.push(event.revision));
    expect(m.revoke('group-test', '9007199254740994', realm)).toBe(true);
    expect(m.current(lease)).toBe(false);
    expect(m.current(unrelated)).toBe(true);
    expect(m.apply(group(), realm)).toBe(false);
    expect(m.apply(group('9007199254740994'), realm)).toBe(false);
    expect(m.revoke('group-test', '9007199254740994', realm)).toBe(false);
    expect(events).toEqual(['9007199254740994']);
    expect(m.apply(group('9007199254740995'), realm)).toBe(true);
    expect(m.current(lease)).toBe(false);
    expect(m.current(m.capture('group-test'))).toBe(true);
    expect(m.revoke('group-test', '9007199254740994', realm)).toBe(false);
    expect(m.acceptsContent('group-test')).toBe(true);
  });
  test('changing someone else does not interrupt my active work', () => {
    const { membership: m, realm } = fixture();
    m.apply(group('1'), realm); const lease = m.capture('group-test');
    m.apply(group('2', ['user-1', 'user-3']), realm);
    expect(m.current(lease)).toBe(true);
  });
  test('malformed owners and membership snapshots never grant access', () => {
    const { membership: m, realm } = fixture();
    for (const value of [
      { ...group(), ownerId: undefined }, { ...group(), membershipRevision: 4 },
      group('1', ['user-2']), group('1', ['user-1', 'user-1']), group('1', ['user-1', 'socket-2'])
    ]) expect(m.apply(value as Channel, realm)).toBe(false);
    expect(m.acceptsContent('group-test')).toBe(false);
  });
  test('valid nonmember snapshot revokes and authoritative missing init can revoke revision zero', () => {
    const { membership: m, realm } = fixture();
    m.apply(group('0'), realm); const lease = m.capture('group-test');
    expect(m.apply({ ...group('1', ['user-2']), ownerId: 'user-2' }, realm)).toBe(false);
    expect(m.current(lease)).toBe(false);
    expect(m.revoke('legacy-id', null, realm)).toBe(true);
    expect(m.acceptsContent('legacy-id')).toBe(false);
  });
  test('persistent tombstones survive reload without granting readiness', () => {
    const { membership: m, realm, deps } = fixture();
    m.apply(group('1'), realm); m.revoke('group-test', '2', realm);
    const reloaded = new GroupMembership(deps);
    expect(reloaded.acceptsContent('group-test')).toBe(false);
    expect(reloaded.apply(group('1'), realm)).toBe(false);
    expect(reloaded.ready()).toBe(false);
  });
  test('account/server round-trip cannot resurrect a lease (ABA)', () => {
    for (const other of [null, { server: 'https://two.example', account: '1' }, { server: 'https://one.example', account: '2' }]) {
      const { membership: m, realm, setContext } = fixture();
      m.apply(group('1'), realm); const lease = m.capture('group-test');
      setContext(other); expect(m.current(lease)).toBe(false);
      expect(m.apply(group('2'), realm)).toBe(false);
      setContext({ server: 'https://one.example', account: '1' });
      expect(m.apply(group('2'), realm)).toBe(true);
      expect(m.current(lease)).toBe(false);
      expect(m.ready()).toBe(false);
    }
  });
  test('logout publishes previous group IDs without writing another realm\'s tombstones', () => {
    const { membership: m, realm, setContext } = fixture();
    m.apply(group('1'), realm);
    const transitions: string[][] = [];
    m.onContextChanged(ids => { transitions.push(ids); m.realm(); }); // safe re-entry
    setContext(null); expect(m.realm()).toBeNull();
    expect(transitions).toEqual([['group-test']]);
    setContext({ server: 'https://other.example', account: '1' });
    const other = m.realm()!;
    expect(m.apply(group('0'), other)).toBe(true);
  });
});

describe('offline group consent', () => {
  test('ephemeral voice actions cannot replay over current reconnect intent', () => {
    const { membership: m, realm } = fixture();
    for (const type of ['voice-channel-join', 'voice-channel-subscribe', 'voice-channel-leave', 'voice-channel-unsubscribe', 'set-voice-transmit-mode']) {
      expect(groupQueueDecision({ type } as QueuedAction, m)).toBe('reject');
      m.finishInit(realm);
      expect(groupQueueDecision({ type, payload: { channelId: 'public-voice' } } as QueuedAction, m)).toBe('reject');
    }
  });
  test('legacy mutations are never replayed, including before init', () => {
    const { membership: m } = fixture();
    for (const type of ['create-group', 'leave-group', 'kick-group-member', 'add-group-member', 'update-group-avatar']) {
      expect(groupQueueDecision({ type } as QueuedAction, m)).toBe('reject');
    }
  });
  test('new group content waits for init, stays account-scoped, and cannot cross removal/re-add', () => {
    const { membership: m, realm, setContext } = fixture();
    m.apply(group('1'), realm);
    const action = { type: 'send-message', payload: { channelId: 'group-test' }, authority: { realm, membershipRevision: '1' } } as QueuedAction;
    expect(groupQueueDecision(action, m)).toBe('defer');
    m.finishInit(realm); expect(groupQueueDecision(action, m)).toBe('send');
    expect(groupQueueDecision({ ...action, authority: undefined }, m)).toBe('reject');
    setContext({ server: 'https://other.example', account: '1' });
    expect(groupQueueDecision(action, m)).toBe('defer');
    setContext({ server: 'https://one.example', account: '1' });
    m.revoke('group-test', '2', realm); m.apply(group('3'), realm); m.finishInit(realm);
    expect(groupQueueDecision(action, m)).toBe('reject');
    expect(groupQueueDecision({ ...action, authority: { realm, membershipRevision: '3' } }, m)).toBe('send');
  });
});
