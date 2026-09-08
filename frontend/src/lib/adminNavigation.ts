export type AdminSection = 'overview' | 'users' | 'roles' | 'channels' | 'uploads' | 'runtime' | 'branding' | 'settings' | 'payments';

type ActiveAdminSection = Exclude<AdminSection, 'uploads' | 'settings'>;
export const ADMIN_SECTIONS: Array<{ id: ActiveAdminSection; label: string; description: string; group: 'Server' | 'People'; staff?: boolean }> = [
	{ id: 'overview', label: 'Overview', description: 'Server health and latest recorded changes', group: 'Server' },
	{ id: 'runtime', label: 'Server health', description: 'Database readiness, uptime and memory', group: 'Server' },
	{ id: 'users', label: 'People', description: 'Members, roles and account recovery', group: 'People', staff: true },
	{ id: 'roles', label: 'Roles', description: 'Understand the built-in permission levels', group: 'People' },
	{ id: 'channels', label: 'Channels', description: 'Browse server channels and open their workspaces', group: 'Server' },
	{ id: 'branding', label: 'Branding', description: 'How this server appears to visitors', group: 'Server' },
	{ id: 'payments', label: 'Payments', description: 'Who can create payment requests', group: 'Server' },
];

export function canManageServer(role: string | null | undefined): boolean {
	return ['owner', 'admin'].includes((role ?? '').toLowerCase());
}

export function adminSectionsFor(role: string | null | undefined) {
	if (canManageServer(role)) return ADMIN_SECTIONS;
	if (['mod', 'moderator'].includes((role ?? '').toLowerCase())) return ADMIN_SECTIONS.filter(section => section.staff);
	return [];
}

/** Legacy destinations resolve into the same visible navigation, never a hidden page. */
export function resolveAdminSection(requested: string, role: string | null | undefined): ActiveAdminSection | null {
	const canonical = requested === 'gates' ? 'roles' : ['uploads', 'settings'].includes(requested) ? 'overview' : requested;
	const allowed = adminSectionsFor(role);
	return allowed.find(section => section.id === canonical)?.id ?? allowed[0]?.id ?? null;
}
