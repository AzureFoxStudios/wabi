import { fade, fly, scale } from 'svelte/transition';
import type { AnimationPassPreset } from '$lib/animationPass';

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutQuint = (t: number) => 1 - Math.pow(1 - t, 5);
const easeOutBack = (t: number) => {
	const c1 = 1.70158;
	const c3 = c1 + 1;
	return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

function getTransitionForPreset(
	node: Element,
	preset: AnimationPassPreset,
	duration: number,
	distance: number
) {
	if (preset === 'fade') {
		return fade(node, { duration, easing: easeOutCubic });
	}
	if (preset === 'scale') {
		return scale(node, { duration, start: 0.985, opacity: 0.2, easing: easeOutBack });
	}
	if (preset === 'flip') {
		return scale(node, { duration, start: 0.93, opacity: 0.12, easing: easeOutQuint });
	}
	return fly(node, { duration, y: distance, opacity: 0.15, easing: easeOutQuint });
}

export function messageItemTransition(
	node: Element,
	params: {
		enabled: boolean;
		preset: AnimationPassPreset;
		duration: number;
		distance: number;
		animate: boolean;
	}
) {
	const reducedMotion = typeof document !== 'undefined' && document.documentElement.getAttribute('data-reduce-motion') === 'true';
	if (reducedMotion) {
		return fade(node, { duration: 0 });
	}
	if (!params.enabled || !params.animate || params.duration <= 0) {
		return fade(node, { duration: 0 });
	}
	return getTransitionForPreset(node, params.preset, params.duration, params.distance);
}
