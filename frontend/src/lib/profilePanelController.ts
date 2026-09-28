import { derived, get, writable, type Readable } from 'svelte/store';
import type { User } from './socket-types';
import { profileIdentityKey } from './profileIdentity';

export function profileIdentity(user: User | null | undefined): string | null {
	return profileIdentityKey(user);
}

/** Resolve socket-id changes by the account ID, never by a display name. */
export function sameProfileIdentity(left: User | null | undefined, right: User | null | undefined): boolean {
	const identity = profileIdentity(left);
	return identity !== null && identity === profileIdentity(right);
}

export interface ProfilePanelSelection {
	server: string;
	account: string;
	user: User;
}

/** Session memory only. The existing layout store owns the panel and its stub. */
export function createProfilePanelController(deps: {
	server: Readable<string>;
	self: Readable<User | null>;
	users: Readable<User[]>;
	members: Readable<User[]>;
}) {
	const selection = writable<ProfilePanelSelection | null>(null);
	const scope = derived([deps.server, deps.self], ([server, self]) => {
		const account = profileIdentity(self);
		return server && account ? { server, account } : null;
	});
	// This subscription remains active even while another dock panel is displayed.
	const stop = scope.subscribe((current) => {
		const selected = get(selection);
		if (selected && (!current || selected.server !== current.server || selected.account !== current.account)) {
			selection.set(null);
		}
	});
	const user = derived([selection, scope, deps.self, deps.users, deps.members], ([selected, current, self, users, members]) => {
		if (!selected || !current || selected.server !== current.server || selected.account !== current.account) return null;
		return [self, ...users, ...members].find((candidate) => sameProfileIdentity(selected.user, candidate)) ?? selected.user;
	});
	return {
		selection: { subscribe: selection.subscribe },
		user,
		select(candidate: User): boolean {
			const current = get(scope);
			if (!current || !profileIdentity(candidate)) return false;
			selection.set({ ...current, user: candidate });
			return true;
		},
		clear() { selection.set(null); },
		clearForServer(server: string) {
			if (get(selection)?.server === server) selection.set(null);
		},
		destroy: stop
	};
}
