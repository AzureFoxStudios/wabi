import { describe, expect, test } from 'bun:test';
import { selectAssignableRoles, selectLoreRoles } from './roleCatalog';

// The server sends `capabilities` for every role in the Lore role store, even
// when the list is empty, and never for the `mod` and `guest` shells.
const catalog = [
	{ roleName: 'owner', displayName: 'Owner', priority: 400, capabilities: ['lore.stage', 'lore.admin'] },
	{ roleName: 'developer', displayName: 'Developer', priority: 260, capabilities: ['lore.stage', 'lore.commit'] },
	{ roleName: 'mod', displayName: 'Moderator', priority: 200 },
	{ roleName: 'member', displayName: 'Member', priority: 100, capabilities: [] },
	{ roleName: 'viewer', displayName: 'Viewer', priority: 100, capabilities: [] },
	{ roleName: 'guest', displayName: 'Guest', priority: 0 },
];

describe('Lore roles offered in the member menu', () => {
	test('a role with no capabilities is still a Lore role', () => {
		// Read access comes from channel membership now, so a read-only role
		// has an empty list. It must stay assignable.
		expect(selectLoreRoles(catalog).map((r) => r.roleName)).toEqual(['owner', 'developer', 'member', 'viewer']);
		expect(selectAssignableRoles(catalog).map((r) => r.roleName)).toContain('viewer');
	});

	test('the moderation and guest shells are not Lore roles', () => {
		const names = selectLoreRoles(catalog).map((r) => r.roleName);
		expect(names).not.toContain('mod');
		expect(names).not.toContain('guest');
	});

	test('a catalog without capability lists falls back to role names', () => {
		const stripped = catalog.map(({ roleName, displayName, priority }) => ({ roleName, displayName, priority }));
		expect(selectLoreRoles(stripped).map((r) => r.roleName)).toEqual(['owner', 'developer', 'member', 'viewer']);
	});
});
