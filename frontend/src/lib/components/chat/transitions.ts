import { browser } from '$app/environment';
import { fade, fly, scale } from 'svelte/transition';
import type { AnimationPassPreset } from '$lib/animationPass';
import type { ChannelPaneAnimation } from './types';

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
		return scale(node, { duration, start: 0.96, opacity: 0.2, easing: easeOutBack });
	}
	if (preset === 'flip') {
		return scale(node, { duration, start: 0.92, opacity: 0.1, easing: easeOutQuint });
	}
	return fly(node, { duration, y: distance, opacity: 0.15, easing: easeOutQuint });
}

export function channelPaneInTransition(node: Element, params: ChannelPaneAnimation) {
	const reducedMotion = browser && document.documentElement.getAttribute('data-reduce-motion') === 'true';
	if (reducedMotion) {
		return fade(node, { duration: 0 });
	}
	if (!params.enabled || params.duration <= 0) {
		return fade(node, { duration: 0 });
	}
	return getTransitionForPreset(node, params.preset, params.duration, params.distance);
}

export function channelPaneOutTransition(node: Element, params: ChannelPaneAnimation) {
	const reducedMotion = browser && document.documentElement.getAttribute('data-reduce-motion') === 'true';
	if (reducedMotion) {
		return fade(node, { duration: 0 });
	}
	if (!params.enabled || params.duration <= 0) {
		return fade(node, { duration: 0 });
	}
	const outDuration = Math.max(80, Math.min(180, Math.round(params.duration * 0.5)));
	return fade(node, { duration: outDuration, easing: easeOutCubic });
}
