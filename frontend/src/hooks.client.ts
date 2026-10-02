import type { ClientInit } from '@sveltejs/kit';
import { hydrateNativePersistentAuthToken } from '$lib/nativeAuthPersistence';
import { installShowcaseBoundary } from '$lib/showcase/boundary';

// SvelteKit awaits native remember-me credentials before session bootstrap.
export const init: ClientInit = async () => {
	installShowcaseBoundary();
	await hydrateNativePersistentAuthToken();
};
