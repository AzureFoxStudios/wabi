/**
 * PWA / display-mode runtime helpers.
 */
import { browser } from '$app/environment';
import { readable } from 'svelte/store';

export type PwaRuntime = 'browser-tab' | 'pwa-standalone' | 'unknown';

export function isStandaloneDisplay(): boolean {
	if (!browser) return false;
	const mq = window.matchMedia('(display-mode: standalone)').matches;
	const iosStandalone =
		typeof (navigator as Navigator & { standalone?: boolean }).standalone === 'boolean' &&
		(navigator as Navigator & { standalone?: boolean }).standalone === true;
	return mq || iosStandalone;
}

export function getPwaRuntime(): PwaRuntime {
	if (!browser) return 'unknown';
	if (isStandaloneDisplay()) return 'pwa-standalone';
	return 'browser-tab';
}

export const standaloneDisplay = readable(false, (set) => {
	if (!browser) return;
	const update = () => set(isStandaloneDisplay());
	update();
	const mql = window.matchMedia('(display-mode: standalone)');
	const onChange = () => update();
	mql.addEventListener('change', onChange);
	return () => mql.removeEventListener('change', onChange);
});
