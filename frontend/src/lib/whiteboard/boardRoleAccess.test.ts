import { describe, expect, test } from 'bun:test';
import { boardRoleAllowsDrawing } from './boardRoleAccess';

describe('board drawing controls follow Authority role values', () => {
	test('moderator preset accepts wire mod and legacy Moderator', () => {
		for (const highestRole of ['mod', 'Moderator', 'admin', 'owner']) {
			expect(boardRoleAllowsDrawing({ drawRole: 'moderators' }, { highestRole })).toBe(true);
		}
		for (const highestRole of ['member', 'artist', 'developer']) {
			expect(boardRoleAllowsDrawing({ drawRole: 'moderators' }, { highestRole })).toBe(false);
		}
	});
	test('selected roles use the current role after reassignment', () => {
		const policy = { drawRole: 'custom' as const, drawRoles: ['artist', 'mod'] };
		expect(boardRoleAllowsDrawing(policy, { highestRole: 'artist' })).toBe(true);
		expect(boardRoleAllowsDrawing(policy, { highestRole: 'Moderator' })).toBe(true);
		expect(boardRoleAllowsDrawing(policy, { highestRole: 'admin', roles: ['artist'] })).toBe(false);
		expect(boardRoleAllowsDrawing({ drawRole: 'custom', drawRoles: [] }, { highestRole: 'artist' })).toBe(false);
	});
	test('member selection excludes unregistered guests while legacy boards stay open', () => {
		expect(boardRoleAllowsDrawing({ drawRole: 'custom', drawRoles: ['member'] }, { highestRole: 'member', isRegistered: false })).toBe(false);
		expect(boardRoleAllowsDrawing({ drawRole: 'custom', drawRoles: ['member'] }, { highestRole: 'member', isRegistered: true })).toBe(true);
		expect(boardRoleAllowsDrawing(undefined, null)).toBe(true);
	});
	test('owner can manage restricted boards and admin preset remains restricted', () => {
		expect(boardRoleAllowsDrawing({ drawRole: 'custom', drawRoles: ['artist'] }, { highestRole: 'owner' })).toBe(true);
		expect(boardRoleAllowsDrawing({ drawRole: 'admins' }, { highestRole: 'mod' })).toBe(false);
		expect(boardRoleAllowsDrawing({ drawRole: 'admins' }, { highestRole: 'admin' })).toBe(true);
	});
});
