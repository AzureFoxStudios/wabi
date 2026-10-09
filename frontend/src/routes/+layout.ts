import { dev } from '$app/environment';

// Wabi is a client-rendered SPA (adapter-static). The dev server's SSR pass trips circular store
// imports, so it is skipped there; production builds keep SvelteKit's default.
export const ssr = !dev;
