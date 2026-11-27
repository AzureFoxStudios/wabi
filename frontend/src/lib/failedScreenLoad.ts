/**
 * Screens are loaded on demand. When one cannot be fetched (the server was updated under an open
 * tab, the network dropped, or a bad copy was cached) nothing used to happen: the person saw a
 * loading line forever, or nothing at all. This turns that into one visible notice.
 */

/** True for the errors browsers raise when a script loaded on demand cannot be fetched or run. */
export function isFailedModuleLoad(reason: unknown): boolean {
	const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
	return /dynamically imported module|importing a module script failed|error loading dynamically|is not a valid JavaScript MIME type|Unable to preload CSS/i.test(message);
}

/** Calls `notify` when a screen fails to load, at most once every `quietMs`. Returns a stop function. */
export function startFailedScreenLoadNotice(notify: () => void, quietMs = 15_000): () => void {
	if (typeof window === 'undefined') return () => {};
	let last = -Infinity;
	const raise = () => {
		const now = performance.now();
		if (now - last < quietMs) return;
		last = now;
		notify();
	};
	// Vite raises this when a preloaded chunk of a dynamic import fails.
	const onPreload = () => raise();
	const onRejection = (event: PromiseRejectionEvent) => { if (isFailedModuleLoad(event.reason)) raise(); };
	window.addEventListener('vite:preloadError', onPreload);
	window.addEventListener('unhandledrejection', onRejection);
	return () => {
		window.removeEventListener('vite:preloadError', onPreload);
		window.removeEventListener('unhandledrejection', onRejection);
	};
}
