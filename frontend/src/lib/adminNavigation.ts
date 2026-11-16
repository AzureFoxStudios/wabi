export type AdminSection =
	| 'overview'
	| 'moderation'
	| 'safety'
	| 'privacy'
	| 'users'
	| 'roles'
	| 'channels'
	| 'storage'
	| 'infrastructure'
	| 'uploads'
	| 'runtime'
	| 'branding'
	| 'settings'
	| 'payments';

type ActiveAdminSection = Exclude<AdminSection, 'uploads' | 'settings'>;
export const ADMIN_SECTIONS: Array<{ id: ActiveAdminSection; labelKey: string; descriptionKey: string; groupKey: string; staff?: boolean; ownerOnly?: boolean }> = [
	{ id: 'overview', labelKey: 'admin_nav.undefined', descriptionKey: 'admin_nav.undefined_desc', groupKey: 'admin_nav.group_server' },
	{ id: 'moderation', labelKey: 'admin_nav.undefined', descriptionKey: 'admin_nav.undefined_desc', groupKey: 'admin_nav.group_safety', staff: true },
	{ id: 'safety', labelKey: 'admin_nav.undefined', descriptionKey: 'admin_nav.undefined_desc', groupKey: 'admin_nav.group_safety' },
	{ id: 'privacy', labelKey: 'admin_nav.undefined', descriptionKey: 'admin_nav.undefined_desc', groupKey: 'admin_nav.group_safety' },
	{ id: 'users', labelKey: 'admin_nav.undefined', descriptionKey: 'admin_nav.undefined_desc', groupKey: 'admin_nav.group_people', staff: true },
	{ id: 'roles', labelKey: 'admin_nav.undefined', descriptionKey: 'admin_nav.undefined_desc', groupKey: 'admin_nav.group_people' },
	{ id: 'channels', labelKey: 'admin_nav.undefined', descriptionKey: 'admin_nav.undefined_desc', groupKey: 'admin_nav.group_server' },
	{ id: 'storage', labelKey: 'admin_nav.undefined', descriptionKey: 'admin_nav.undefined_desc', groupKey: 'admin_nav.group_server' },
	{ id: 'infrastructure', labelKey: 'admin_nav.undefined', descriptionKey: 'admin_nav.undefined_desc', groupKey: 'admin_nav.group_server' },
	{ id: 'runtime', labelKey: 'admin_nav.undefined', descriptionKey: 'admin_nav.undefined_desc', groupKey: 'admin_nav.group_server' },
	{ id: 'branding', labelKey: 'admin_nav.undefined', descriptionKey: 'admin_nav.undefined_desc', groupKey: 'admin_nav.group_server' },
	{ id: 'payments', labelKey: 'admin_nav.undefined', descriptionKey: 'admin_nav.undefined_desc', groupKey: 'admin_nav.group_server' },
];

export function canManageServer(role: string | null | undefined): boolean {
	return ['owner', 'admin'].includes((role ?? '').toLowerCase());
}

export function adminSectionsFor(role: string | null | undefined) {
	const normalized = (role ?? '').toLowerCase();
	if (canManageServer(normalized)) return ADMIN_SECTIONS.filter(section => !section.ownerOnly || normalized === 'owner');
	if (['mod', 'moderator'].includes(normalized)) return ADMIN_SECTIONS.filter(section => section.staff);
	return [];
}

/** Legacy destinations resolve into the same visible navigation, never a hidden page. */
export function resolveAdminSection(requested: string, role: string | null | undefined): ActiveAdminSection | null {
	const canonical = requested === 'gates' ? 'roles' : requested === 'uploads' ? 'storage' : requested === 'settings' ? 'overview' : requested;
	const allowed = adminSectionsFor(role);
	return allowed.find(section => section.id === canonical)?.id ?? allowed[0]?.id ?? null;
}
