/**
 * Mobile / installed shell attributes on <html>.
 * Sets data-shell + display-mode early so CSS can branch without FOUC thrash.
 */
import { browser } from '$app/environment';
import { get } from 'svelte/store';
import { isMobile } from '$lib/layoutStoreStates';
import { isStandaloneDisplay } from '$lib/pwa/platform';

let started = false;
let cleanupFns: Array<() => void> = [];

export type VisualViewportMeasurement = {
	layoutHeight: number;
	viewportHeight: number;
	viewportOffsetTop?: number;
};

/**
 * Compute the portion of the layout viewport obscured below the visual viewport.
 * Keeping this pure lets us regression-test real Android/iOS measurement shapes
 * without pretending a desktop browser is a physical phone.
 */
export function computeKeyboardInset({
	layoutHeight,
	viewportHeight,
	viewportOffsetTop = 0
}: VisualViewportMeasurement): number {
	const layout = Number.isFinite(layoutHeight) ? layoutHeight : 0;
	const viewport = Number.isFinite(viewportHeight) ? viewportHeight : layout;
	const offset = Number.isFinite(viewportOffsetTop) ? viewportOffsetTop : 0;
	return Math.max(0, Math.round(layout - viewport - offset));
}

/** Browser chrome/jitter below this threshold is not treated as an IME. */
export function isKeyboardInsetOpen(inset: number, minimumInset = 80): boolean {
	return Number.isFinite(inset) && inset > minimumInset;
}

function applyShell(compact: boolean): void {
	if (!browser) return;
	const root = document.documentElement;
	root.dataset.shell = compact ? 'mobile' : 'desktop';
	root.classList.toggle('is-mobile-shell', compact);
	root.classList.toggle('is-desktop-shell', !compact);

	const standalone = isStandaloneDisplay();
	root.dataset.displayMode = standalone ? 'standalone' : 'browser';
	root.classList.toggle('is-pwa-standalone', standalone);
}

function bindKeyboardInset(): () => void {
	if (!browser || !window.visualViewport) return () => {};

	const vv = window.visualViewport;
	const update = () => {
		const inset = computeKeyboardInset({
			layoutHeight: window.innerHeight,
			viewportHeight: vv.height,
			viewportOffsetTop: vv.offsetTop
		});
		const root = document.documentElement;
		root.style.setProperty('--keyboard-inset', `${inset}px`);
		if (isKeyboardInsetOpen(inset)) {
			root.dataset.keyboardOpen = '1';
		} else {
			delete root.dataset.keyboardOpen;
		}
	};

	update();
	vv.addEventListener('resize', update);
	vv.addEventListener('scroll', update);
	window.addEventListener('orientationchange', update);
	return () => {
		vv.removeEventListener('resize', update);
		vv.removeEventListener('scroll', update);
		window.removeEventListener('orientationchange', update);
		document.documentElement.style.removeProperty('--keyboard-inset');
		delete document.documentElement.dataset.keyboardOpen;
	};
}

/** Call once from root layout. */
export function startMobileShell(): () => void {
	if (!browser) return () => {};
	if (started) return () => {};
	started = true;

	applyShell(get(isMobile));
	const unsub = isMobile.subscribe((compact) => applyShell(compact));

	const mqlStandalone = window.matchMedia('(display-mode: standalone)');
	const onStandalone = () => applyShell(get(isMobile));
	mqlStandalone.addEventListener('change', onStandalone);

	const unbindKb = bindKeyboardInset();

	cleanupFns = [
		() => unsub(),
		() => mqlStandalone.removeEventListener('change', onStandalone),
		unbindKb,
		() => {
			started = false;
		}
	];

	return () => {
		for (const fn of cleanupFns) fn();
		cleanupFns = [];
	};
}
