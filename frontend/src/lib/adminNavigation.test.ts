import { describe, expect, test } from 'bun:test';
import { adminSectionsFor, resolveAdminSection } from './adminNavigation';

describe('one canonical Admin navigation', () => {
	test('admins can reach real controls; obsolete destinations do not create extra pages', () => {
		expect(adminSectionsFor('owner').map(section => section.id)).toEqual([
			'overview',
			'moderation',
			'safety',
			'privacy',
			'users',
			'roles',
			'channels',
			'storage',
			'infrastructure',
			'runtime',
			'branding',
			'payments',
		]);
		expect(resolveAdminSection('gates', 'admin')).toBe('roles');
		expect(resolveAdminSection('uploads', 'owner')).toBe('storage');
		expect(resolveAdminSection('settings', 'owner')).toBe('overview');
	});
	test('moderators reach staff surfaces (moderation triage, people) but not admin-only statistics or settings', () => {
		expect(adminSectionsFor('mod').map(section => section.id)).toEqual(['moderation', 'users']);
		expect(resolveAdminSection('runtime', 'moderator')).toBe('moderation');
	});
	test('role loss and invalid destinations cannot leave privileged sections selected', () => {
		expect(resolveAdminSection('settings', 'member')).toBeNull();
		expect(resolveAdminSection('users', null)).toBeNull();
		expect(resolveAdminSection('missing', 'owner')).toBe('overview');
	});
});
