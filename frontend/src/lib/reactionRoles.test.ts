import { describe, expect, test } from 'bun:test';
import { normalizeReactionRoles, reactionEntries, reactionRulesProblem } from './reactionRoles';

const roles = [
	{ id: 'banana', name: 'Banana Jammers' },
	{ id: 'kiwi', name: 'Kiwi Killers' }
];

describe('role reactions', () => {
	test('an emoji that gives a role is shown before anyone has reacted', () => {
		const entries = reactionEntries({ '1F44D': ['user-2'] }, [{ emojiId: '1F34C', roleId: 'banana' }], roles);
		expect(entries).toEqual([
			{ emojiId: '1F34C', userIds: [], roleName: 'Banana Jammers' },
			{ emojiId: '1F44D', userIds: ['user-2'] }
		]);
	});

	test('people already on a role emoji are counted on it, once', () => {
		const entries = reactionEntries({ '1F34C': ['user-2', 'user-3'] }, [{ emojiId: '1F34C', roleId: 'banana' }], roles);
		expect(entries).toEqual([{ emojiId: '1F34C', userIds: ['user-2', 'user-3'], roleName: 'Banana Jammers' }]);
	});

	test('a rule for a role this app does not know draws as an ordinary reaction', () => {
		expect(reactionEntries({}, [{ emojiId: '1F34C', roleId: 'gone' }], roles)).toEqual([]);
		expect(reactionEntries({ '1F34C': ['user-2'] }, [{ emojiId: '1F34C', roleId: 'gone' }], roles)).toEqual([
			{ emojiId: '1F34C', userIds: ['user-2'] }
		]);
	});

	test('an ordinary reaction nobody holds any more is not drawn', () => {
		expect(reactionEntries({ '1F44D': [] }, undefined, roles)).toEqual([]);
	});

	test('server data is read defensively', () => {
		expect(normalizeReactionRoles(null)).toEqual({});
		expect(
			normalizeReactionRoles({
				m1: { channelId: 'c1', rules: [{ emojiId: '1F34C', roleId: 'banana' }, { emojiId: 5 }] },
				m2: { channelId: 'c1', rules: [] },
				m3: 'nonsense'
			})
		).toEqual({ m1: { channelId: 'c1', rules: [{ emojiId: '1F34C', roleId: 'banana' }] } });
	});

	test('rules need an emoji and a role each, and each emoji once', () => {
		expect(reactionRulesProblem([{ emojiId: '1F34C', roleId: '' }])).toBe('incomplete');
		expect(reactionRulesProblem([{ emojiId: '1F34C', roleId: 'banana' }, { emojiId: '1F34C', roleId: 'kiwi' }])).toBe('duplicate');
		expect(reactionRulesProblem([{ emojiId: '1F34C', roleId: 'banana' }, { emojiId: '1F95D', roleId: 'kiwi' }])).toBeNull();
		expect(reactionRulesProblem([])).toBeNull();
	});
});
