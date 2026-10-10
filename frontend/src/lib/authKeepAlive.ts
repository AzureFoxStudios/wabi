import { ensureFreshAccessToken } from './api/authRefresh';

/**
 * Keep a remembered session alive without the user noticing.
 *
 * Access tokens last 15 minutes; the refresh token (30-day inactivity window,
 * renewed on every refresh) is what actually keeps someone signed in. Phones
 * freeze or throttle a backgrounded PWA, so the first moments after returning
 * to the app, or after a network change, are exactly when the access token is
 * most likely stale. Renew it then, and also on a slow timer while the app is
 * running (for example during a long call), so every request and reconnect
 * starts with a valid credential.
 *
 * Failures are silent by design: ensureFreshAccessToken never clears the
 * session on a network error, and the socket/request 401 handlers still get
 * their own retry.
 */
const RENEW_WHEN_REMAINING_MS = 3 * 60_000;
const TIMER_INTERVAL_MS = 60_000;
const MIN_GAP_MS = 5_000;

export function installAuthKeepAlive(target: { document?: Document; window?: Window } = {
	document: typeof document === 'undefined' ? undefined : document,
	window: typeof window === 'undefined' ? undefined : window
}): () => void {
	const { document: doc, window: win } = target;
	if (!doc || !win) return () => {};

	let last = 0;
	let running = false;
	const renew = (): void => {
		const now = Date.now();
		if (running || now - last < MIN_GAP_MS) return;
		last = now;
		running = true;
		void ensureFreshAccessToken(undefined, { skewMs: RENEW_WHEN_REMAINING_MS, timeoutMs: 10_000 })
			.catch(() => false)
			.finally(() => { running = false; });
	};
	const onVisible = (): void => { if (doc.visibilityState !== 'hidden') renew(); };

	doc.addEventListener('visibilitychange', onVisible);
	win.addEventListener('pageshow', renew);
	win.addEventListener('online', renew);
	win.addEventListener('focus', renew);
	const timer = setInterval(renew, TIMER_INTERVAL_MS);

	return () => {
		clearInterval(timer);
		doc.removeEventListener('visibilitychange', onVisible);
		win.removeEventListener('pageshow', renew);
		win.removeEventListener('online', renew);
		win.removeEventListener('focus', renew);
	};
}
