import { describe, expect, test } from 'bun:test';
import { normalizeListedRoles, rolesHeldBy, toggledRoleIds } from './serverRoles';

describe('the one role list', () => {
	const roles = normalizeListedRoles([
		{ id: 'community-banana', name: 'Banana Jammers', description: '', selfAssignable: true },
		{ id: 'community-kiwi', name: 'Kiwi Killers', selfAssignable: false },
		{ id: 'community-old', name: 'From an older server' },
		{ name: 'no id' }
	]);

	test('roles from a server without the self-choice flag are self-chosen', () => {
		expect(roles.map((role) => [role.name, role.selfAssignable])).toEqual([
			['Banana Jammers', true],
			['Kiwi Killers', false],
			['From an older server', true]
		]);
	});

	test('a person can hold several roles, shown in list order, and removed roles drop out', () => {
		const holders = { '7': ['community-kiwi', 'community-gone', 'community-banana'] };
		expect(rolesHeldBy(roles, holders, 7).map((role) => role.name)).toEqual(['Banana Jammers', 'Kiwi Killers']);
		expect(rolesHeldBy(roles, holders, 8)).toEqual([]);
		expect(rolesHeldBy(roles, holders, null)).toEqual([]);
	});

	test('ticking and unticking a role never duplicates it', () => {
		expect(toggledRoleIds(['a'], 'b', true)).toEqual(['a', 'b']);
		expect(toggledRoleIds(['a', 'b'], 'b', true)).toEqual(['a', 'b']);
		expect(toggledRoleIds(['a', 'b'], 'a', false)).toEqual(['b']);
	});
});
