import type { ClientInit } from '@sveltejs/kit';
import { hydrateNativePersistentAuthToken } from '$lib/nativeAuthPersistence';
import { ensureFreshAccessToken } from '$lib/api/authRefresh';
import { installAuthKeepAlive } from '$lib/authKeepAlive';
import { installShowcaseBoundary } from '$lib/showcase/boundary';

// SvelteKit awaits native remember-me credentials before session bootstrap.
export const init: ClientInit = async () => {
	installShowcaseBoundary();
	await hydrateNativePersistentAuthToken();
	// A remembered session may hold an expired 15-minute access token; renew it
	// before the socket tries to connect so a relaunch never shows a login screen.
	await ensureFreshAccessToken().catch(() => false);
	// Keep it fresh while the app runs and when it returns from the background.
	installAuthKeepAlive();
};
