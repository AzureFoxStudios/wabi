export interface AdminRoleDefinition {
	roleName: string;
	displayName: string;
	priority: number;
	description?: string;
	color: string | null;
	isHoisted: boolean;
}

export interface AdminRoleCatalogState {
	roles: AdminRoleDefinition[];
	loading: boolean;
	error: string;
}

interface RoleSocket {
	connected: boolean;
	on(event: string, listener: (payload: any) => void): unknown;
	off(event: string, listener: (payload: any) => void): unknown;
	emit(event: string): unknown;
}

/** This is a server catalog, not a fallback inferred from members or statistics. */
export function parseAdminRoleCatalog(payload: unknown): AdminRoleDefinition[] | null {
	if (!payload || typeof payload !== 'object' || !Array.isArray((payload as any).roles)) return null;
	const roles: AdminRoleDefinition[] = [];
	const seen = new Set<string>();
	for (const role of (payload as any).roles) {
		if (!role || typeof role.roleName !== 'string' || !role.roleName.trim() ||
			typeof role.displayName !== 'string' || !role.displayName.trim() ||
			!Number.isFinite(role.priority) || seen.has(role.roleName)) return null;
		seen.add(role.roleName);
		roles.push({ roleName: role.roleName, displayName: role.displayName, priority: role.priority,
			description: typeof role.description === 'string' ? role.description : undefined,
			color: typeof role.color === 'string' ? role.color : null, isHoisted: role.isHoisted === true });
	}
	return roles.sort((a, b) => b.priority - a.priority);
}

/** One socket owns its listeners and timeout; replacement cannot publish stale roles. */
export function createAdminRoleCatalog(onChange: (state: AdminRoleCatalogState) => void, timeoutMs = 8_000) {
	let socket: RoleSocket | null = null;
	let cleanup = () => {};
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	let state: AdminRoleCatalogState = { roles: [], loading: false, error: '' };
	const publish = (next: AdminRoleCatalogState) => { state = next; if (!disposed) onChange(state); };
	const stopTimer = () => { clearTimeout(timer); timer = undefined; };
	function refresh() {
		if (disposed) return;
		stopTimer();
		if (!socket?.connected) {
			publish({ roles: [], loading: false, error: 'Reconnect to load server roles.' });
			return;
		}
		publish({ ...state, loading: true, error: '' });
		timer = setTimeout(() => publish({ ...state, loading: false, error: 'The server did not respond. Try loading roles again.' }), timeoutMs);
		socket.emit('get-role-definitions');
	}
	return {
		refresh,
		bind(next: RoleSocket | null) {
			if (disposed) return;
			cleanup(); stopTimer(); socket = next;
			let active = true;
			const onRoles = (payload: unknown) => {
				if (!active || disposed) return;
				stopTimer();
				const roles = parseAdminRoleCatalog(payload);
				publish(roles === null
					? { roles: [], loading: false, error: 'This server returned an unsupported role catalog. Update the server and try again.' }
					: { roles, loading: false, error: '' });
			};
			const onError = () => {
				if (!active || disposed) return;
				stopTimer(); publish({ roles: [], loading: false, error: 'Could not load server roles. Try again.' });
			};
			next?.on('role-definitions-updated', onRoles);
			next?.on('role-definitions-error', onError);
			cleanup = () => {
				active = false;
				next?.off('role-definitions-updated', onRoles);
				next?.off('role-definitions-error', onError);
			};
			state = { roles: [], loading: false, error: '' }; refresh();
		},
		dispose() { disposed = true; cleanup(); stopTimer(); socket = null; }
	};
}
