import { activeServerUrl, normalizeServerUrl } from './serverUrl';
import { derived } from 'svelte/store';
import { currentUser, serverMembers, users } from './presenceIdentity';
import { onAuthSessionCleared } from './authSession';
import { createProfilePanelController } from './profilePanelController';

export const profilePanel = createProfilePanelController({
	server: derived(activeServerUrl, (server) => normalizeServerUrl(server) || server),
	self: currentUser,
	users,
	members: serverMembers
});

// Logout/relogin as the same account also retires the old selection.
onAuthSessionCleared((server) => profilePanel.clearForServer(server));
export const profilePanelUser = profilePanel.user;
