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
export const ADMIN_SECTIONS: Array<{ id: ActiveAdminSection; label: string; description: string; group: 'Server' | 'People' | 'Safety'; staff?: boolean; ownerOnly?: boolean }> = [
	{ id: 'overview', label: 'Overview', description: 'Community health, server health and things that need attention', group: 'Server' },
	{ id: 'moderation', label: 'Moderation', description: 'Reports, staff actions and moderation triage', group: 'Safety', staff: true },
	{ id: 'safety', label: 'Safety rules', description: 'Simple automatic rules, filters and escalation behavior', group: 'Safety' },
	{ id: 'privacy', label: 'Privacy & retention', description: 'Choose retention, private-space automation and local data boundaries', group: 'Safety' },
	{ id: 'users', label: 'People', description: 'Members, roles, account recovery and moderation context', group: 'People', staff: true },
	{ id: 'roles', label: 'Roles', description: 'Understand and manage the built-in permission levels', group: 'People' },
	{ id: 'channels', label: 'Channels', description: 'Browse server channels and open their workspaces', group: 'Server' },
	{ id: 'storage', label: 'Storage', description: 'See what is using disk space and safely revoke uploaded files', group: 'Server' },
	{ id: 'infrastructure', label: 'Infrastructure', description: 'Connected relays, helpers and node health', group: 'Server' },
	{ id: 'runtime', label: 'Diagnostics', description: 'Database readiness, uptime, memory and runtime tuning', group: 'Server' },
	{ id: 'branding', label: 'Branding', description: 'How this server appears to visitors', group: 'Server' },
	{ id: 'payments', label: 'Payments', description: 'Who can create payment requests', group: 'Server' },
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
