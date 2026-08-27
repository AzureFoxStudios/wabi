/**
 * Global bun:test preload.
 *
 * SvelteKit virtual modules (`$app/environment`, ...) only exist under Vite.
 * Suites used to mock them individually; any suite that forgot poisoned the
 * shared module cache for every later import ("export 'setAuthToken' not
 * found" — the long-standing baseline bun/CI test failure). Register the
 * virtual modules ONCE, process-wide, before any suite runs.
 */
import { mock } from 'bun:test';

mock.module('$app/environment', () => ({
	browser: false,
	dev: false,
	prerendering: false,
	ssr: true,
	building: false,
	version: {}
}));

mock.module('$app/navigation', () => ({
	goto: () => Promise.resolve(),
	invalidate: () => Promise.resolve(),
	invalidateAll: () => Promise.resolve(),
	prefetch: () => Promise.resolve(),
	prefetchRoutes: () => Promise.resolve(),
	beforeNavigate: () => {},
	afterNavigate: () => {},
	onNavigate: () => Promise.resolve()
}));

mock.module('$app/state', () => ({
	page: { get current() { return {}; } },
	navigating: { get current() { return null; } },
	updated: { get current() { return false; }, subscribe: () => () => {} }
}));
